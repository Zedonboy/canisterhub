//! Every `icp new` / `icp build` / `cargo test` / `icp deploy` invocation runs
//! directly on the host the orchestrator process itself runs on - there is no
//! sandbox boundary here (see `README.md`'s "Notes and limitations" for what
//! that means operationally). This module has two halves:
//!
//! - [`run`]: a plain one-shot exec (no PTY) for commands already known to be
//!   fully deterministic and non-interactive (`icp new -s ...`, `cargo
//!   check`, `icp canister id`).
//! - [`InteractiveSessions`]: a real interactive shell for the coding
//!   subagent's own `shell`/`shell_send` tools (see `llm/codetools.rs`) -
//!   spawns a command under a pseudo-terminal (a real PTY, not plain pipes,
//!   since interactive-prompt libraries like the one `icp new` uses without
//!   `-s` generally render differently, or misbehave outright, when
//!   stdin/stdout aren't a real terminal) and lets the subagent read whatever
//!   it prints, decide an answer using its own reasoning, and send that
//!   answer back as keystrokes - across as many turns as the prompt needs -
//!   rather than requiring every prompt to be discovered and flag-suppressed
//!   ahead of time.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct ExecResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl ExecResult {
    /// Compiler/test output can be huge; the LLM only needs enough to fix the
    /// problem, and it all goes into the job log and the tool-call result sent
    /// back to the model.
    pub fn combined_tail(&self, max_chars: usize) -> String {
        let mut combined = String::new();
        if !self.stdout.is_empty() {
            combined.push_str("--- stdout ---\n");
            combined.push_str(&self.stdout);
        }
        if !self.stderr.is_empty() {
            combined.push_str("\n--- stderr ---\n");
            combined.push_str(&self.stderr);
        }
        if combined.len() > max_chars {
            let start = combined.len() - max_chars;
            format!("[...truncated...]\n{}", &combined[start..])
        } else {
            combined
        }
    }
}

/// Runs `bash -lc <command>` directly on the host, with `cwd` as the working
/// directory and stdin closed (this is for commands already known to be
/// fully non-interactive - anything that might prompt should go through
/// [`InteractiveSessions`] instead, not this).
pub async fn run(cwd: &Path, command: &str, timeout: Duration) -> anyhow::Result<ExecResult> {
    tokio::fs::create_dir_all(cwd).await?;

    let child = tokio::process::Command::new("bash")
        .args(["-lc", command])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn bash: {e}"))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result?,
        Err(_) => {
            return Err(anyhow::anyhow!("command timed out after {:?}: {command}", timeout));
        }
    };

    Ok(ExecResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Adds `principal` as an additional controller of `canister` (an icp.yaml
/// name, or a bare canister principal if it isn't registered in a project
/// at all - `icp canister settings update` accepts either) - additive,
/// never replaces the existing controller list (verified directly: the
/// canister's original deploy identity/anonymous controller stays a
/// controller too, not swapped out). This is what makes a project's
/// canisters genuinely, cryptographically owned by the real user who
/// requested them (their principal, proven via the JWT bridge - see
/// `ic::backend`'s own `owner` field), not just left under a shared
/// orchestrator deploy identity - see the project's own session notes on
/// why this doesn't (and, for real security reasons, shouldn't) instead
/// try to "borrow" the user's own Internet Identity session key.
pub async fn add_controller(cwd: &Path, canister: &str, principal: &str, is_mainnet: bool, timeout: Duration) -> anyhow::Result<ExecResult> {
    let flags = if is_mainnet { " -e ic --identity deploy" } else { "" };
    let command = format!("icp canister settings update {canister} --add-controller {principal} -f{flags} 2>&1");
    run(cwd, &command, timeout).await
}

/// Finds the most recently modified `.wasm` under `dir`, preferring one whose file
/// stem contains `prefer_name_hint` (the icp-cli canister name, always "backend"
/// for projects scaffolded from the `rust` template - see README). icp-cli's
/// on-disk artifact layout is treated as an implementation detail here rather than
/// hardcoded, so this still works if that layout changes.
pub fn find_wasm_artifact(dir: &Path, prefer_name_hint: &str) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    collect_wasm_files(dir, &mut candidates);

    candidates.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });

    candidates
        .iter()
        .rev()
        .find(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.contains(prefer_name_hint))
                .unwrap_or(false)
        })
        .or_else(|| candidates.last())
        .cloned()
}

fn collect_wasm_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip cargo's own intermediate build graph - it can contain
            // incidental .wasm dependency artifacts that aren't our canister.
            if path.file_name().and_then(|n| n.to_str()) == Some("incremental") {
                continue;
            }
            collect_wasm_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("wasm") {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Interactive sessions
// ---------------------------------------------------------------------------

/// One in-progress interactive command: a child process whose stdin/stdout/
/// stderr are all attached to the same PTY, split into independently owned
/// read/write halves so a session can be pulled out of the registry, read
/// from or written to across an `.await`, and put back - a plain
/// `Mutex<HashMap<...>>` can't be held across an `.await` point itself (its
/// guard isn't `Send`), so every [`InteractiveSessions`] method below locks
/// only long enough to remove or (re)insert a session, never while awaiting
/// its I/O.
struct Session {
    child: tokio::process::Child,
    read_half: pty_process::OwnedReadPty,
    write_half: pty_process::OwnedWritePty,
}

/// Outcome of starting or continuing one interactive session.
#[derive(Debug)]
pub struct SessionResult {
    /// Everything the process printed since the last time this session was
    /// read from (all of it, for a freshly started session).
    pub output: String,
    /// Whether the process has exited.
    pub exited: bool,
    /// Only meaningful when `exited` is true.
    pub success: Option<bool>,
    /// Present only when `exited` is false - pass this to [`InteractiveSessions::send`]
    /// to continue the same session.
    pub session_id: Option<String>,
}

/// A job's registry of currently-open interactive sessions (see this
/// module's doc comment). One instance lives on `JobContext`, so sessions
/// never cross job boundaries.
#[derive(Default)]
pub struct InteractiveSessions {
    sessions: Mutex<HashMap<String, Session>>,
}

impl InteractiveSessions {
    /// Spawns `command` (via `bash -lc`) under a fresh PTY rooted at `cwd`,
    /// then reads its output until it exits, looks like it's blocked waiting
    /// on input, or `hard_timeout` elapses (in which case the process is
    /// killed). See [`pump`] for the "looks blocked waiting on input"
    /// heuristic.
    pub async fn start(&self, cwd: &Path, command: &str, idle_timeout: Duration, hard_timeout: Duration) -> anyhow::Result<SessionResult> {
        let (pty, pts) = pty_process::open()?;
        // A generous, fixed size - just needs to be big enough that a
        // prompt library doesn't wrap/misbehave on an unusually narrow
        // terminal; nothing here depends on the exact numbers.
        let _ = pty.resize(pty_process::Size::new(40, 120));

        let child = pty_process::Command::new("bash")
            .args(["-lc", command])
            .current_dir(cwd)
            // Interactive-prompt libraries (dialoguer/console/crossterm, what
            // `icp new`'s own prompt uses) check `TERM` to decide whether
            // they can do raw-mode input at all - verified directly: without
            // this, a real `icp new` prompt renders once and then the
            // process exits immediately instead of waiting for a keypress,
            // because it doesn't believe it has a real interactive terminal.
            // We don't inherit the orchestrator process's own environment
            // (a background service may well have none set, or an
            // unrelated one), so this is set unconditionally rather than
            // only as a fallback.
            .env("TERM", "xterm-256color")
            // No `--rm`-equivalent auto-cleanup exists on a bare host exec,
            // so this is the backstop if this session is ever dropped
            // without `close_all` reaching it first (e.g. a panic elsewhere
            // in the same job) - `close_all` itself still explicitly kills
            // every open session for prompt cleanup on the normal path.
            .kill_on_drop(true)
            .spawn(pts)
            .map_err(|e| anyhow::anyhow!("failed to spawn '{command}' under a pty: {e}"))?;
        let (read_half, write_half) = pty.into_split();

        let mut session = Session { child, read_half, write_half };
        let result = pump(&mut session, idle_timeout, hard_timeout).await?;
        self.finish(session, result)
    }

    /// Sends `input` (followed by a newline, as if typed then Enter) to a
    /// still-open session from a prior [`start`](Self::start) or `send`
    /// call, then reads the same way `start` does.
    pub async fn send(&self, session_id: &str, input: &str, idle_timeout: Duration, hard_timeout: Duration) -> anyhow::Result<SessionResult> {
        let mut session = self
            .sessions
            .lock()
            .unwrap()
            .remove(session_id)
            .ok_or_else(|| anyhow::anyhow!("no open interactive session with id '{session_id}' - it may have already exited"))?;

        session.write_half.write_all(format!("{input}\n").as_bytes()).await?;
        session.write_half.flush().await?;

        let result = pump(&mut session, idle_timeout, hard_timeout).await?;
        self.finish(session, result)
    }

    /// Puts `session` back in the registry (under a fresh id) if it's still
    /// running, or leaves it out (so it's dropped, and with it the pty/child
    /// handles) if it already exited.
    fn finish(&self, session: Session, mut result: SessionResult) -> anyhow::Result<SessionResult> {
        if !result.exited {
            let id = uuid::Uuid::new_v4().to_string();
            self.sessions.lock().unwrap().insert(id.clone(), session);
            result.session_id = Some(id);
        }
        Ok(result)
    }

    /// Kills and drops every still-open session - there is no more `--rm`
    /// container to reap an abandoned interactive process automatically, so
    /// this must be called explicitly once a job (or one
    /// `write_and_compile_project` call) is done, win or lose.
    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.start_kill();
        }
    }
}

/// Reads from `session` until *either* the process exits, or it looks
/// blocked waiting on input, or `hard_timeout` has elapsed since this call
/// started (in which case the process is killed and treated as having
/// failed). "Looks blocked waiting on input" requires *both*: no new output
/// for `idle_timeout`, *and* the output collected so far doesn't end in a
/// newline - a prompt library prints its question and then blocks on a line
/// read without ever emitting a trailing newline, while a quietly-compiling
/// build's last progress line always ends with one. Either signal alone is
/// unreliable (a slow but silent compile would trip a bare idle timeout; a
/// process that happens to pause mid-line for an unrelated reason would trip
/// a bare newline check) - both together is the same practical heuristic
/// real expect-style automation tools use.
async fn pump(session: &mut Session, idle_timeout: Duration, hard_timeout: Duration) -> anyhow::Result<SessionResult> {
    let mut output = String::new();
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    let mut last_activity = Instant::now();

    loop {
        let hard_left = hard_timeout.saturating_sub(start.elapsed());
        if hard_left.is_zero() {
            let _ = session.child.start_kill();
            let _ = session.child.wait().await;
            return Ok(SessionResult { output, exited: true, success: Some(false), session_id: None });
        }
        let idle_left = idle_timeout.saturating_sub(last_activity.elapsed());
        let wait_for = idle_left.min(hard_left);

        tokio::select! {
            read_result = session.read_half.read(&mut buf) => {
                match read_result {
                    Ok(0) | Err(_) => {
                        // EOF (or, on some platforms, an I/O error once the pty's
                        // slave side is gone) - the process is exiting or already
                        // has; waiting on it here is fast either way.
                        let status = session.child.wait().await?;
                        return Ok(SessionResult { output, exited: true, success: Some(status.success()), session_id: None });
                    }
                    Ok(n) => {
                        output.push_str(&String::from_utf8_lossy(&buf[..n]));
                        last_activity = Instant::now();
                    }
                }
            }
            status = session.child.wait() => {
                let status = status?;
                return Ok(SessionResult { output, exited: true, success: Some(status.success()), session_id: None });
            }
            () = tokio::time::sleep(wait_for) => {
                if wait_for == idle_left && looks_like_a_pending_prompt(&output) {
                    return Ok(SessionResult { output, exited: false, success: None, session_id: None });
                }
                // Either the hard cap (not the idle timer) is what actually
                // elapsed - the top of the loop re-checks it and kills the
                // process next iteration - or output so far doesn't look
                // like a pending prompt (a quiet compile phase, not a
                // prompt): reset the idle clock so this keeps waiting
                // patiently instead of busy-looping on an already-expired
                // idle timer.
                last_activity = Instant::now();
            }
        }
    }
}

/// Whether `output`'s current tail looks like a live prompt still waiting
/// on a keypress, given that it's also been idle for `idle_timeout` - two
/// independent signals real interactive-prompt libraries produce:
///
/// - It doesn't end in a newline: a plain line-read prompt (`read`, a
///   password prompt, etc.) prints its question and then blocks without
///   ever emitting a trailing newline.
/// - The most recent "hide cursor" / "show cursor" ANSI sequence
///   (`\x1b[?25l` / `\x1b[?25h`) seen so far is a hide with no matching show
///   after it: a TUI-style prompt (an arrow-key `Select` menu, a spinner)
///   hides the cursor while it owns the terminal and shows it again only
///   once it's actually done - verified directly against `icp new`'s own
///   `Select` prompt, whose fully-rendered menu frame *does* end with a
///   trailing newline (defeating the first signal alone) but leaves the
///   cursor hidden the entire time it's waiting for an arrow key.
fn looks_like_a_pending_prompt(output: &str) -> bool {
    if !output.ends_with('\n') {
        return true;
    }
    let last_hide = output.rfind("\x1b[?25l");
    let last_show = output.rfind("\x1b[?25h");
    matches!((last_hide, last_show), (Some(_), None)) || matches!((last_hide, last_show), (Some(h), Some(s)) if h > s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_a_pending_prompt_detects_a_plain_line_prompt_with_no_trailing_newline() {
        assert!(looks_like_a_pending_prompt("Enter your name: "));
    }

    #[test]
    fn looks_like_a_pending_prompt_ignores_ordinary_newline_terminated_output() {
        // e.g. a quiet compile phase's last progress line - not a prompt.
        assert!(!looks_like_a_pending_prompt("   Compiling foo v0.1.0\n"));
    }

    #[test]
    fn looks_like_a_pending_prompt_detects_a_tui_menu_with_cursor_still_hidden() {
        // The real, verified shape of `icp new`'s own Select prompt: its
        // fully-rendered frame ends with a trailing newline (which alone
        // would say "not a prompt"), but the cursor-hide sequence has no
        // matching show yet, because it's still waiting for a keypress.
        let output = "\x1b[?25lWhich option?\n> a\n  b\n";
        assert!(looks_like_a_pending_prompt(output));
    }

    #[test]
    fn looks_like_a_pending_prompt_ignores_a_tui_frame_whose_cursor_was_shown_again() {
        // The same menu, but already resolved (cursor restored) - e.g. right
        // after the user's answer was accepted and the tool moved on.
        let output = "\x1b[?25lWhich option?\n> a\n  b\n\x1b[?25hDone.\n";
        assert!(!looks_like_a_pending_prompt(output));
    }

    fn test_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("process-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn run_executes_a_command_and_captures_output() {
        let result = run(&test_dir(), "echo hello", Duration::from_secs(5)).await.unwrap();
        assert!(result.success);
        assert!(result.stdout.contains("hello"));
    }

    #[tokio::test]
    async fn run_reports_failure_for_a_nonzero_exit() {
        let result = run(&test_dir(), "exit 1", Duration::from_secs(5)).await.unwrap();
        assert!(!result.success);
    }

    #[tokio::test]
    async fn start_reports_immediate_completion_for_a_fast_command() {
        let sessions = InteractiveSessions::default();
        let result = sessions
            .start(&test_dir(), "echo hi", Duration::from_millis(200), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(result.exited);
        assert_eq!(result.success, Some(true));
        assert!(result.output.contains("hi"));
        assert!(result.session_id.is_none());
    }

    #[tokio::test]
    async fn start_reports_waiting_for_input_when_the_command_blocks_on_read() {
        let sessions = InteractiveSessions::default();
        let result = sessions
            .start(&test_dir(), "read x; echo got:$x", Duration::from_millis(200), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(!result.exited, "expected the still-blocked `read` to be reported as waiting, got: {}", result.output);
        assert!(result.session_id.is_some());
    }

    #[tokio::test]
    async fn send_continues_a_waiting_session_to_completion() {
        let sessions = InteractiveSessions::default();
        let started = sessions
            .start(&test_dir(), "read x; echo got:$x", Duration::from_millis(200), Duration::from_secs(5))
            .await
            .unwrap();
        let session_id = started.session_id.expect("should still be waiting on `read`");

        let result = sessions.send(&session_id, "hello", Duration::from_millis(200), Duration::from_secs(5)).await.unwrap();
        assert!(result.exited);
        assert_eq!(result.success, Some(true));
        assert!(result.output.contains("got:hello"), "unexpected output: {}", result.output);
    }

    #[tokio::test]
    async fn send_to_an_unknown_session_id_fails_clearly() {
        let sessions = InteractiveSessions::default();
        let err = sessions.send("no-such-session", "x", Duration::from_millis(50), Duration::from_secs(1)).await.unwrap_err();
        assert!(err.to_string().contains("no open interactive session"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn hard_timeout_kills_a_command_that_never_exits_or_goes_idle() {
        let sessions = InteractiveSessions::default();
        // Keeps printing (never idle) and never exits on its own - the idle
        // heuristic alone would wait forever, so this only terminates via
        // the hard cap below.
        let command = "while true; do printf x; sleep 0.02; done";
        let result = sessions
            .start(&test_dir(), command, Duration::from_secs(5), Duration::from_millis(300))
            .await
            .unwrap();
        assert!(result.exited, "expected the hard timeout to force this to a stop");
        assert_eq!(result.success, Some(false));
        assert!(result.session_id.is_none());
    }
}
