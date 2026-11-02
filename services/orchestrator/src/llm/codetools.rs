//! The coding subagent's tools - modeled closely on a real coding agent's
//! toolset. [OpenCode](https://opencode.ai)'s own tool directory
//! (github.com/sst/opencode/tree/dev/packages/opencode/src/tool) is the
//! reference this was checked against: `read`, `write`, `edit`,
//! `apply_patch`, `glob`, `grep`, and `shell` are all named and shaped after
//! its equivalents, and `todowrite` after its task-list tool. Reimplemented
//! from scratch in Rust (not ported code - OpenCode's own is TypeScript),
//! scaled to what one coding subagent working on one freshly-scaffolded
//! Rust/icp-cli project actually needs:
//!
//! - No formatter integration, no permission-prompt loop of *our own*
//!   (nothing to prompt about at that level - this runs unattended in a
//!   background job); `shell`'s own interactive-prompt handling (below) is a
//!   different thing entirely - a real CLI prompt from the command being
//!   run, not a permission check on the tool call itself.
//! - No real LSP client (OpenCode's own `lsp` tool talks to a real language
//!   server for live diagnostics) - `cargo check`, auto-run after every
//!   `write`/`edit`/`apply_patch`, plays that role instead. Real compiler
//!   diagnostics, just not live/incremental ones - a deliberate scope cut,
//!   not an oversight.
//! - No `webfetch`/`websearch` (out of scope for this subagent, not a
//!   sandboxing restriction - see README.md's "Notes and limitations" for
//!   what running directly on the host does and doesn't restrict), no
//!   `task` (this subagent is already one level of delegation from the
//!   top-level orchestration agent; nesting another isn't needed), no
//!   `plan`/`skill` (TUI-oriented concepts with no clear equivalent when
//!   nothing runs attended in a foreground session).
//! - `ask_user` (below) *is* the one exception to "nothing runs
//!   attended" - not a live TUI prompt, but a real pause-and-resume: the
//!   job's state moves to `AwaitingAnswer`, `GET /jobs/:id` surfaces the
//!   question, and `POST /jobs/:id/answer` resumes it. Modeled on the same
//!   idea as OpenCode's own `question` tool, adapted to this project's
//!   already-polling job model instead of a live terminal.

use crate::llm::tools::{err_json, parse_args, JobContext};
use regex::Regex;
use rig::tool::{DynamicTool, ToolContext, ToolOutput};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Tracks which files a `read` call has actually shown the model this
/// conversation - `write`/`edit`/`apply_patch`'s enforced read-before-write
/// rule (below) checks against this, not just file existence, so the
/// subagent can't blindly overwrite/patch content it's never seen.
#[derive(Default)]
pub struct ReadTracker {
    read: Mutex<HashSet<PathBuf>>,
}

impl ReadTracker {
    fn mark_read(&self, path: &Path) {
        self.read.lock().unwrap().insert(path.to_path_buf());
    }

    fn was_read(&self, path: &Path) -> bool {
        self.read.lock().unwrap().contains(path)
    }
}

/// Resolves `relative` against `project_dir`, rejecting anything that would
/// escape it - an absolute path, or a `..` component. This is a sanity check
/// against an ordinary mistake or naive escape attempt, not a real security
/// boundary - there isn't one any more now that commands run directly on
/// the host (see README.md's "Notes and limitations").
pub fn resolve_path(project_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim();
    if relative.is_empty() || relative == "." {
        return Ok(project_dir.to_path_buf());
    }
    if Path::new(relative).is_absolute() {
        return Err(format!(
            "path '{relative}' must be relative to the project root, not absolute"
        ));
    }

    let mut resolved = project_dir.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            std::path::Component::Normal(seg) => resolved.push(seg),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(format!("path '{relative}' must not contain '..'"))
            }
            _ => {
                return Err(format!(
                    "path '{relative}' contains an invalid path component"
                ))
            }
        }
    }
    Ok(resolved)
}

fn affects_compilation(path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) == Some("rs") {
        return true;
    }
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("Cargo.toml") | Some("Cargo.lock")
    )
}

fn is_excluded(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components().any(|c| match c {
                std::path::Component::Normal(seg) => {
                    let seg = seg.to_string_lossy();
                    seg == "target" || seg == ".git" || seg == ".icp" || seg.starts_with('.')
                }
                _ => false,
            })
        })
        .unwrap_or(false)
}

fn walk_files(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_excluded(&path, root) {
            continue;
        }
        if path.is_dir() {
            walk_files(&path, root, out);
        } else {
            out.push(path);
        }
    }
}

/// Our stand-in for a real LSP's live diagnostics - see this module's doc
/// comment. Runs `cargo check` directly on the host, rooted at the project
/// dir, capped to a short-ish timeout (fast feedback, not a full build) and
/// folded into `write`/`edit`/`apply_patch`'s own response as `cargo_check`,
/// so fixing an ordinary compiler error never costs a separate tool call.
/// `cargo check` never prompts, so this uses the plain one-shot
/// `process::run` rather than an interactive session.
async fn quick_check(ctx: &JobContext, project_dir: &Path) -> Value {
    let command = "cargo check --target wasm32-unknown-unknown --quiet 2>&1";
    let timeout = Duration::from_secs(ctx.config.command_timeout_secs.min(120));
    match crate::process::run(project_dir, command, timeout).await {
        Ok(result) => json!({ "success": result.success, "output": result.combined_tail(3000) }),
        Err(e) => json!({ "success": false, "output": format!("failed to run cargo check: {e}") }),
    }
}

/// Builds every tool in this module, scoped to one project directory and
/// sharing one [`ReadTracker`] across the whole subagent conversation.
pub fn build_code_tools(
    ctx: Arc<JobContext>,
    project_dir: PathBuf,
    read_tracker: Arc<ReadTracker>,
) -> Vec<DynamicTool> {
    vec![
        read_tool(ctx.clone(), project_dir.clone(), read_tracker.clone()),
        write_tool(ctx.clone(), project_dir.clone(), read_tracker.clone()),
        edit_tool(ctx.clone(), project_dir.clone(), read_tracker.clone()),
        apply_patch_tool(ctx.clone(), project_dir.clone(), read_tracker.clone()),
        glob_tool(ctx.clone(), project_dir.clone()),
        grep_tool(ctx.clone(), project_dir.clone()),
        shell_tool(ctx.clone(), project_dir),
        shell_send_tool(ctx.clone()),
        todowrite_tool(ctx.clone()),
        ask_user_tool(ctx),
    ]
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

fn read_tool(
    ctx: Arc<JobContext>,
    project_dir: PathBuf,
    read_tracker: Arc<ReadTracker>,
) -> DynamicTool {
    DynamicTool::new(
        "read",
        "Read a file's contents (line-numbered, paginated via offset/limit - default 2000 lines from the \
         start) or list a directory's immediate entries if the path is a directory. Path is relative to the \
         project root; empty or '.' means the project root itself. Always read a file before write/edit/ \
         apply_patch touches an existing one - they refuse to touch a file this hasn't been called on yet \
         in this conversation.",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "offset": { "type": "integer", "description": "0-based line to start from (files only), default 0" },
                "limit": { "type": "integer", "description": "Max lines to return (files only), default 2000" }
            },
            "required": ["path"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let read_tracker = read_tracker.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    path: String,
                    offset: Option<usize>,
                    limit: Option<usize>,
                }
                let args: Args = parse_args(args)?;
                let resolved = match resolve_path(&project_dir, &args.path) {
                    Ok(p) => p,
                    Err(e) => return Ok(err_json(e)),
                };
                if !resolved.exists() {
                    return Ok(err_json(format!("'{}' doesn't exist", args.path)));
                }

                if resolved.is_dir() {
                    let mut entries: Vec<String> = match std::fs::read_dir(&resolved) {
                        Ok(rd) => rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect(),
                        Err(e) => return Ok(err_json(format!("failed to list '{}': {e}", args.path))),
                    };
                    entries.sort();
                    ctx.log("read", format!("listed directory '{}' ({} entries)", args.path, entries.len()));
                    return Ok(ToolOutput::json(json!({ "success": true, "type": "directory", "entries": entries })));
                }

                let content = match std::fs::read_to_string(&resolved) {
                    Ok(c) => c,
                    Err(e) => return Ok(err_json(format!("failed to read '{}': {e}", args.path))),
                };
                read_tracker.mark_read(&resolved);

                let lines: Vec<&str> = content.lines().collect();
                let total = lines.len();
                let offset = args.offset.unwrap_or(0);
                let limit = args.limit.unwrap_or(2000);
                let numbered = lines
                    .iter()
                    .enumerate()
                    .skip(offset)
                    .take(limit)
                    .map(|(i, line)| format!("{:>6}\t{line}", i + 1))
                    .collect::<Vec<_>>()
                    .join("\n");

                ctx.log("read", format!("read '{}' ({total} lines total, from offset {offset})", args.path));
                Ok(ToolOutput::json(json!({ "success": true, "type": "file", "content": numbered, "total_lines": total })))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

fn write_tool(
    ctx: Arc<JobContext>,
    project_dir: PathBuf,
    read_tracker: Arc<ReadTracker>,
) -> DynamicTool {
    DynamicTool::new(
        "write",
        "Create a new file, or fully overwrite an existing one, at a path relative to the project root \
         (parent directories are created as needed). Refuses to overwrite a file that already existed unless \
         `read` was called on it first in this conversation - it can't blindly clobber content it hasn't seen. \
         For a .rs/Cargo.toml/Cargo.lock path, automatically runs `cargo check` afterward and includes the \
         result as `cargo_check` - fast compiler feedback, no separate tool call needed.",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "content": { "type": "string" }
            },
            "required": ["path", "content"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let read_tracker = read_tracker.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    path: String,
                    content: String,
                }
                let args: Args = parse_args(args)?;
                let resolved = match resolve_path(&project_dir, &args.path) {
                    Ok(p) => p,
                    Err(e) => return Ok(err_json(e)),
                };
                if resolved.is_file() && !read_tracker.was_read(&resolved) {
                    return Ok(err_json(format!("'{}' already exists and hasn't been read in this conversation - call read on it first", args.path)));
                }
                if let Some(parent) = resolved.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        return Ok(err_json(format!("failed to create directories for '{}': {e}", args.path)));
                    }
                }
                if let Err(e) = std::fs::write(&resolved, &args.content) {
                    return Ok(err_json(format!("failed to write '{}': {e}", args.path)));
                }
                read_tracker.mark_read(&resolved);
                ctx.log("write", format!("wrote '{}' ({} bytes)", args.path, args.content.len()));

                let mut response = json!({ "success": true });
                if affects_compilation(&resolved) {
                    response["cargo_check"] = quick_check(&ctx, &project_dir).await;
                }
                Ok(ToolOutput::json(response))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

fn edit_tool(
    ctx: Arc<JobContext>,
    project_dir: PathBuf,
    read_tracker: Arc<ReadTracker>,
) -> DynamicTool {
    DynamicTool::new(
        "edit",
        "Replace an exact block of text in an existing file, at a path relative to the project root. Fails \
         if old_string isn't found verbatim, or (unless replace_all) if it's found more than once - rather \
         than guessing which occurrence was meant. The file must have been `read` first in this conversation. \
         For a .rs/Cargo.toml/Cargo.lock path, automatically runs `cargo check` afterward and includes the \
         result as `cargo_check`.",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of requiring exactly one (default false)" }
            },
            "required": ["path", "old_string", "new_string"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let read_tracker = read_tracker.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    path: String,
                    old_string: String,
                    new_string: String,
                    #[serde(default)]
                    replace_all: bool,
                }
                let args: Args = parse_args(args)?;
                let resolved = match resolve_path(&project_dir, &args.path) {
                    Ok(p) => p,
                    Err(e) => return Ok(err_json(e)),
                };
                if !read_tracker.was_read(&resolved) {
                    return Ok(err_json(format!("'{}' hasn't been read in this conversation yet - call read on it first", args.path)));
                }
                let content = match std::fs::read_to_string(&resolved) {
                    Ok(c) => c,
                    Err(e) => return Ok(err_json(format!("failed to read '{}': {e}", args.path))),
                };

                let occurrences = content.matches(&args.old_string).count();
                if occurrences == 0 {
                    return Ok(err_json(format!("old_string not found in '{}'", args.path)));
                }
                if occurrences > 1 && !args.replace_all {
                    return Ok(err_json(format!("old_string found {occurrences} times in '{}' - make it more specific, or set replace_all", args.path)));
                }
                let updated = if args.replace_all {
                    content.replace(&args.old_string, &args.new_string)
                } else {
                    content.replacen(&args.old_string, &args.new_string, 1)
                };
                if let Err(e) = std::fs::write(&resolved, &updated) {
                    return Ok(err_json(format!("failed to write '{}': {e}", args.path)));
                }
                ctx.log("edit", format!("edited '{}' ({occurrences} occurrence(s) replaced)", args.path));

                let mut response = json!({ "success": true });
                if affects_compilation(&resolved) {
                    response["cargo_check"] = quick_check(&ctx, &project_dir).await;
                }
                Ok(ToolOutput::json(response))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

fn apply_patch_tool(
    ctx: Arc<JobContext>,
    project_dir: PathBuf,
    read_tracker: Arc<ReadTracker>,
) -> DynamicTool {
    DynamicTool::new(
        "apply_patch",
        "Apply a multi-file patch in one call, in the standard 'apply_patch' envelope format - useful for \
         several related changes (including adding/deleting whole files) at once, as an alternative to edit. \
         Format:\n\
         *** Begin Patch\n\
         *** Add File: path/to/new.rs\n\
         +line one\n\
         +line two\n\
         *** Update File: path/to/existing.rs\n\
         @@ optional context label\n\
          unchanged context line\n\
         -old line\n\
         +new line\n\
          unchanged context line\n\
         *** Delete File: path/to/remove.rs\n\
         *** End Patch\n\
         An 'Update File' section may include '*** Move to: new/path' right after it to rename while editing. \
         Each hunk's context+removed lines (the ' ' and '-' prefixed lines together) must match the file \
         exactly once, the same rule edit's old_string follows. Every file an Update or Delete section \
         touches must have been `read` in this conversation first; Add File may not already exist. For any \
         .rs/Cargo.toml/Cargo.lock path touched, automatically runs `cargo check` afterward as `cargo_check`.",
        json!({
            "type": "object",
            "properties": { "patch": { "type": "string" } },
            "required": ["patch"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let read_tracker = read_tracker.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    patch: String,
                }
                let args: Args = parse_args(args)?;

                let ops = match patch::parse(&args.patch) {
                    Ok(ops) if !ops.is_empty() => ops,
                    Ok(_) => return Ok(err_json("patch contains no operations".to_string())),
                    Err(e) => return Ok(err_json(format!("failed to parse patch: {e}"))),
                };

                let touched = match patch::apply(&project_dir, &ops, &read_tracker) {
                    Ok(paths) => paths,
                    Err(e) => return Ok(err_json(e)),
                };
                for path in &touched {
                    read_tracker.mark_read(path);
                }
                ctx.log("apply_patch", format!("applied {} operation(s), touching {} file(s)", ops.len(), touched.len()));

                let mut response = json!({ "success": true, "files_touched": touched.len() });
                if touched.iter().any(|p| affects_compilation(p)) {
                    response["cargo_check"] = quick_check(&ctx, &project_dir).await;
                }
                Ok(ToolOutput::json(response))
            })
        },
    )
}

/// The `apply_patch` envelope format's parser/applier - split out for
/// testability (pure parsing/string logic, no `JobContext` needed).
mod patch {
    use super::{resolve_path, ReadTracker};
    use std::path::{Path, PathBuf};

    #[derive(Debug, PartialEq)]
    pub enum Op {
        Add {
            path: String,
            content: String,
        },
        Delete {
            path: String,
        },
        Update {
            path: String,
            move_to: Option<String>,
            hunks: Vec<Hunk>,
        },
    }

    #[derive(Debug, PartialEq)]
    pub struct Hunk {
        pub old: String,
        pub new: String,
    }

    pub fn parse(text: &str) -> Result<Vec<Op>, String> {
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() && lines[i].trim().is_empty() {
            i += 1;
        }
        if i >= lines.len() || lines[i].trim() != "*** Begin Patch" {
            return Err("patch must start with '*** Begin Patch'".to_string());
        }
        i += 1;

        let mut ops = Vec::new();
        loop {
            if i >= lines.len() {
                return Err("patch is missing '*** End Patch'".to_string());
            }
            let line = lines[i];
            if line.trim() == "*** End Patch" {
                break;
            }
            if let Some(path) = line.strip_prefix("*** Add File: ") {
                let path = path.trim().to_string();
                i += 1;
                let mut content_lines = Vec::new();
                while i < lines.len() && !lines[i].starts_with("*** ") {
                    match lines[i].strip_prefix('+') {
                        Some(rest) => content_lines.push(rest),
                        None if lines[i].is_empty() => content_lines.push(""),
                        None => return Err(format!(
                            "expected a '+'-prefixed content line in Add File '{path}', got: {:?}",
                            lines[i]
                        )),
                    }
                    i += 1;
                }
                ops.push(Op::Add {
                    path,
                    content: content_lines.join("\n"),
                });
            } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
                ops.push(Op::Delete {
                    path: path.trim().to_string(),
                });
                i += 1;
            } else if let Some(path) = line.strip_prefix("*** Update File: ") {
                let path = path.trim().to_string();
                i += 1;
                let mut move_to = None;
                if i < lines.len() {
                    if let Some(dest) = lines[i].strip_prefix("*** Move to: ") {
                        move_to = Some(dest.trim().to_string());
                        i += 1;
                    }
                }
                let mut hunks = Vec::new();
                while i < lines.len() && lines[i].starts_with("@@") {
                    i += 1;
                    let mut old_lines = Vec::new();
                    let mut new_lines = Vec::new();
                    while i < lines.len()
                        && !lines[i].starts_with("*** ")
                        && !lines[i].starts_with("@@")
                    {
                        let l = lines[i];
                        if let Some(rest) = l.strip_prefix('-') {
                            old_lines.push(rest);
                        } else if let Some(rest) = l.strip_prefix('+') {
                            new_lines.push(rest);
                        } else if let Some(rest) = l.strip_prefix(' ') {
                            old_lines.push(rest);
                            new_lines.push(rest);
                        } else if l.is_empty() {
                            old_lines.push("");
                            new_lines.push("");
                        } else {
                            return Err(format!(
                                "unrecognized hunk line in Update File '{path}': {l:?}"
                            ));
                        }
                        i += 1;
                    }
                    hunks.push(Hunk {
                        old: old_lines.join("\n"),
                        new: new_lines.join("\n"),
                    });
                }
                if hunks.is_empty() {
                    return Err(format!("Update File '{path}' has no @@ hunks"));
                }
                ops.push(Op::Update {
                    path,
                    move_to,
                    hunks,
                });
            } else if line.trim().is_empty() {
                i += 1;
            } else {
                return Err(format!("unrecognized patch line: {line:?}"));
            }
        }
        Ok(ops)
    }

    pub fn apply(
        project_dir: &Path,
        ops: &[Op],
        read_tracker: &ReadTracker,
    ) -> Result<Vec<PathBuf>, String> {
        let mut touched = Vec::new();
        for op in ops {
            match op {
                Op::Add { path, content } => {
                    let resolved = resolve_path(project_dir, path)?;
                    if resolved.exists() {
                        return Err(format!("Add File '{path}': already exists"));
                    }
                    if let Some(parent) = resolved.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            format!("Add File '{path}': failed to create directories: {e}")
                        })?;
                    }
                    std::fs::write(&resolved, content)
                        .map_err(|e| format!("Add File '{path}': {e}"))?;
                    touched.push(resolved);
                }
                Op::Delete { path } => {
                    let resolved = resolve_path(project_dir, path)?;
                    if !read_tracker.was_read(&resolved) {
                        return Err(format!(
                            "Delete File '{path}': hasn't been read in this conversation yet"
                        ));
                    }
                    std::fs::remove_file(&resolved)
                        .map_err(|e| format!("Delete File '{path}': {e}"))?;
                    touched.push(resolved);
                }
                Op::Update {
                    path,
                    move_to,
                    hunks,
                } => {
                    let resolved = resolve_path(project_dir, path)?;
                    if !read_tracker.was_read(&resolved) {
                        return Err(format!(
                            "Update File '{path}': hasn't been read in this conversation yet"
                        ));
                    }
                    let mut content = std::fs::read_to_string(&resolved)
                        .map_err(|e| format!("Update File '{path}': {e}"))?;
                    for hunk in hunks {
                        let occurrences = content.matches(&hunk.old).count();
                        if occurrences == 0 {
                            return Err(format!(
                                "Update File '{path}': a hunk's context/old lines weren't found"
                            ));
                        }
                        if occurrences > 1 {
                            return Err(format!("Update File '{path}': a hunk's context/old lines matched more than once - make it more specific"));
                        }
                        content = content.replacen(&hunk.old, &hunk.new, 1);
                    }
                    let dest = match move_to {
                        Some(new_path) => {
                            let dest = resolve_path(project_dir, new_path)?;
                            if let Some(parent) = dest.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| format!("Update File '{path}': failed to create directories for move: {e}"))?;
                            }
                            dest
                        }
                        None => resolved.clone(),
                    };
                    std::fs::write(&dest, &content)
                        .map_err(|e| format!("Update File '{path}': {e}"))?;
                    if move_to.is_some() {
                        std::fs::remove_file(&resolved).map_err(|e| {
                            format!(
                                "Update File '{path}': failed to remove old path after move: {e}"
                            )
                        })?;
                    }
                    touched.push(dest);
                }
            }
        }
        Ok(touched)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "codetools-patch-test-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn parses_add_update_delete() {
            // Built via an explicit join (rather than `\`-continued lines) since a
            // `\`-line-continuation strips the next line's leading whitespace,
            // which would silently eat the space-prefixed context line's marker.
            let text = [
                "*** Begin Patch",
                "*** Add File: src/new.rs",
                "+fn new() {}",
                "*** Update File: src/lib.rs",
                "@@ ",
                " fn old() {}",
                "-    1",
                "+    2",
                "*** Delete File: src/gone.rs",
                "*** End Patch",
            ]
            .join("\n");
            let text = text.as_str();
            let ops = parse(text).unwrap();
            assert_eq!(ops.len(), 3);
            assert_eq!(
                ops[0],
                Op::Add {
                    path: "src/new.rs".into(),
                    content: "fn new() {}".into()
                }
            );
            match &ops[1] {
                Op::Update {
                    path,
                    move_to,
                    hunks,
                } => {
                    assert_eq!(path, "src/lib.rs");
                    assert_eq!(*move_to, None);
                    assert_eq!(hunks.len(), 1);
                    assert_eq!(hunks[0].old, "fn old() {}\n    1");
                    assert_eq!(hunks[0].new, "fn old() {}\n    2");
                }
                other => panic!("expected Update, got {other:?}"),
            }
            assert_eq!(
                ops[2],
                Op::Delete {
                    path: "src/gone.rs".into()
                }
            );
        }

        #[test]
        fn parses_update_with_move() {
            let text = "*** Begin Patch\n*** Update File: old.rs\n*** Move to: new.rs\n@@ \n-a\n+b\n*** End Patch";
            let ops = parse(text).unwrap();
            match &ops[0] {
                Op::Update { move_to, .. } => assert_eq!(move_to.as_deref(), Some("new.rs")),
                other => panic!("expected Update, got {other:?}"),
            }
        }

        #[test]
        fn rejects_missing_begin_marker() {
            assert!(parse("*** Add File: x\n+y\n*** End Patch").is_err());
        }

        #[test]
        fn rejects_missing_end_marker() {
            assert!(parse("*** Begin Patch\n*** Add File: x\n+y").is_err());
        }

        #[test]
        fn rejects_add_file_with_non_plus_line() {
            let text = "*** Begin Patch\n*** Add File: x\nno prefix here\n*** End Patch";
            assert!(parse(text).is_err());
        }

        #[test]
        fn apply_add_creates_a_new_file() {
            let dir = test_dir("add");
            let tracker = ReadTracker::default();
            let ops = vec![Op::Add {
                path: "new.rs".to_string(),
                content: "hello".to_string(),
            }];
            let touched = apply(&dir, &ops, &tracker).unwrap();
            assert_eq!(touched, vec![dir.join("new.rs")]);
            assert_eq!(
                std::fs::read_to_string(dir.join("new.rs")).unwrap(),
                "hello"
            );
        }

        #[test]
        fn apply_add_rejects_an_existing_file() {
            let dir = test_dir("add-existing");
            std::fs::write(dir.join("existing.rs"), "old").unwrap();
            let tracker = ReadTracker::default();
            let ops = vec![Op::Add {
                path: "existing.rs".to_string(),
                content: "new".to_string(),
            }];
            assert!(apply(&dir, &ops, &tracker).is_err());
        }

        #[test]
        fn apply_update_requires_the_file_to_have_been_read_first() {
            let dir = test_dir("update-unread");
            std::fs::write(dir.join("f.rs"), "fn a() {}\n").unwrap();
            let tracker = ReadTracker::default();
            let ops = vec![Op::Update {
                path: "f.rs".to_string(),
                move_to: None,
                hunks: vec![Hunk {
                    old: "a".to_string(),
                    new: "b".to_string(),
                }],
            }];
            assert!(apply(&dir, &ops, &tracker).is_err());
        }

        #[test]
        fn apply_update_replaces_matched_hunk_content() {
            let dir = test_dir("update");
            let path = dir.join("f.rs");
            std::fs::write(&path, "fn a() {}\nfn b() {}\n").unwrap();
            let tracker = ReadTracker::default();
            tracker.mark_read(&path);
            let ops = vec![Op::Update {
                path: "f.rs".to_string(),
                move_to: None,
                hunks: vec![Hunk {
                    old: "fn a() {}".to_string(),
                    new: "fn a() { changed(); }".to_string(),
                }],
            }];
            apply(&dir, &ops, &tracker).unwrap();
            let content = std::fs::read_to_string(&path).unwrap();
            assert!(content.contains("fn a() { changed(); }"));
            assert!(content.contains("fn b() {}"));
        }

        #[test]
        fn apply_update_rejects_ambiguous_hunk() {
            let dir = test_dir("update-ambiguous");
            let path = dir.join("f.rs");
            std::fs::write(&path, "same\nsame\n").unwrap();
            let tracker = ReadTracker::default();
            tracker.mark_read(&path);
            let ops = vec![Op::Update {
                path: "f.rs".to_string(),
                move_to: None,
                hunks: vec![Hunk {
                    old: "same".to_string(),
                    new: "different".to_string(),
                }],
            }];
            assert!(apply(&dir, &ops, &tracker).is_err());
        }

        #[test]
        fn apply_update_with_move_renames_the_file() {
            let dir = test_dir("update-move");
            let old_path = dir.join("old.rs");
            std::fs::write(&old_path, "content\n").unwrap();
            let tracker = ReadTracker::default();
            tracker.mark_read(&old_path);
            let ops = vec![Op::Update {
                path: "old.rs".to_string(),
                move_to: Some("new.rs".to_string()),
                hunks: vec![Hunk {
                    old: "content".to_string(),
                    new: "changed".to_string(),
                }],
            }];
            apply(&dir, &ops, &tracker).unwrap();
            assert!(!old_path.exists());
            assert_eq!(
                std::fs::read_to_string(dir.join("new.rs")).unwrap(),
                "changed\n"
            );
        }

        #[test]
        fn apply_delete_requires_read_first_and_removes_the_file() {
            let dir = test_dir("delete");
            let path = dir.join("gone.rs");
            std::fs::write(&path, "x").unwrap();
            let tracker = ReadTracker::default();
            let ops = vec![Op::Delete {
                path: "gone.rs".to_string(),
            }];
            assert!(
                apply(&dir, &ops, &tracker).is_err(),
                "must refuse before the file has been read"
            );
            tracker.mark_read(&path);
            apply(&dir, &ops, &tracker).unwrap();
            assert!(!path.exists());
        }
    }
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

fn glob_tool(ctx: Arc<JobContext>, project_dir: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "glob",
        "Find files by name pattern (e.g. 'src/**/*.rs'), relative to the project root. Skips target/, \
         .git/, .icp/, and other hidden directories.",
        json!({
            "type": "object",
            "properties": { "pattern": { "type": "string" } },
            "required": ["pattern"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    pattern: String,
                }
                let args: Args = parse_args(args)?;
                let full_pattern = project_dir.join(&args.pattern);
                let glob_iter = match glob::glob(&full_pattern.to_string_lossy()) {
                    Ok(g) => g,
                    Err(e) => return Ok(err_json(format!("invalid glob pattern: {e}"))),
                };

                let mut matches: Vec<String> = glob_iter
                    .flatten()
                    .filter(|p| !is_excluded(p, &project_dir))
                    .filter_map(|p| p.strip_prefix(&project_dir).ok().map(|rel| rel.to_string_lossy().into_owned()))
                    .collect();
                matches.sort();

                ctx.log("glob", format!("pattern={:?} -> {} match(es)", args.pattern, matches.len()));
                Ok(ToolOutput::json(json!({ "success": true, "matches": matches })))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GREP_MAX_RESULTS: usize = 200;

fn grep_tool(ctx: Arc<JobContext>, project_dir: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "grep",
        "Regex search across file contents under the project root, optionally restricted to filenames \
         matching a glob. Skips target/, .git/, .icp/, and other hidden directories. Returns matching lines \
         with file path and line number, capped at 200 results.",
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regular expression to search for" },
                "glob": { "type": "string", "description": "Optional filename glob to restrict the search, e.g. '*.rs'" }
            },
            "required": ["pattern"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let project_dir = project_dir.clone();
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    pattern: String,
                    glob: Option<String>,
                }
                let args: Args = parse_args(args)?;
                let re = match Regex::new(&args.pattern) {
                    Ok(r) => r,
                    Err(e) => return Ok(err_json(format!("invalid regex: {e}"))),
                };
                let glob_matcher = match &args.glob {
                    Some(pattern) => match glob::Pattern::new(pattern) {
                        Ok(p) => Some(p),
                        Err(e) => return Ok(err_json(format!("invalid glob: {e}"))),
                    },
                    None => None,
                };

                let mut files = Vec::new();
                walk_files(&project_dir, &project_dir, &mut files);

                let mut results = Vec::new();
                'files: for file in files {
                    if let Some(g) = &glob_matcher {
                        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                        if !g.matches(name) {
                            continue;
                        }
                    }
                    let Ok(content) = std::fs::read_to_string(&file) else { continue };
                    let rel = file.strip_prefix(&project_dir).unwrap_or(&file).to_string_lossy().into_owned();
                    for (i, line) in content.lines().enumerate() {
                        if re.is_match(line) {
                            results.push(json!({ "file": rel, "line": i + 1, "text": line }));
                            if results.len() >= GREP_MAX_RESULTS {
                                break 'files;
                            }
                        }
                    }
                }

                ctx.log("grep", format!("pattern={:?} glob={:?} -> {} match(es)", args.pattern, args.glob, results.len()));
                Ok(ToolOutput::json(json!({ "success": true, "matches": results })))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// shell / shell_send
//
// Commands run directly on the host now (no more Docker sandbox - see
// README.md's "Notes and limitations"), under a real pseudo-terminal, so a
// command that shows an interactive prompt instead of finishing doesn't
// just hang forever with nothing to react to: `shell` reports
// `waiting_for_input: true` plus a `session_id` instead, and `shell_send`
// lets this agent read that prompt text, decide an answer itself (the same
// reasoning already happening every tool-calling turn), and type it in -
// repeating as many times as the command actually prompts. See
// `process::InteractiveSessions` for exactly how "looks like it's waiting
// for input" is decided (a heuristic, not a guarantee - a command that goes
// quiet for a long stretch without a full prompt-shaped pause could
// occasionally be reported this way too; if `output` doesn't obviously look
// like a question, it's fine to answer with an empty `shell_send` input
// (which just sends a newline) to see whether it was really waiting or is
// simply still working).
// ---------------------------------------------------------------------------

fn shell_tool(ctx: Arc<JobContext>, project_dir: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "shell",
        "Run a shell command directly on the host, with the project directory (or a subfolder of it, via \
         `cwd`) as the working directory. Use this to compile (`icp build`), test (`cargo test`), manage \
         dependencies (`cargo add`/`cargo remove`), run icp-cli commands, or anything else beyond file \
         operations - use read/write/edit/apply_patch for those instead, not this. `icp build` succeeding \
         (producing the canister wasm + candid interface) is the authoritative compile gate - `cargo check` \
         (via write/edit/apply_patch) catches ordinary errors fast, but doesn't produce the wasm or catch \
         icp-cli-specific issues the way `icp build` does. Keep fixing and re-running it until it succeeds, \
         or you're confident it can't be fixed with the information you have. \
         \n\nIf the command shows an interactive prompt instead of finishing (e.g. `icp new` run without \
         `-s`), this returns `waiting_for_input: true` with a `session_id` and whatever it printed so far \
         in `output`, instead of hanging - read that prompt, decide the answer, and call shell_send with \
         that session_id and your answer.",
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to run, e.g. \"icp build\" or \"cargo add serde --features derive\"" },
                "cwd": { "type": "string", "description": "Optional subfolder (relative to the project root) to run the command in - omit to run at the project root" },
                "timeout_secs": { "type": "integer", "description": "Override the default hard timeout, in seconds - the command is killed if it neither finishes nor prompts within this long" }
            },
            "required": ["command"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            let project_dir = project_dir.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    command: String,
                    cwd: Option<String>,
                    timeout_secs: Option<u64>,
                }
                let args: Args = parse_args(args)?;
                let cwd = match resolve_path(&project_dir, args.cwd.as_deref().unwrap_or(".")) {
                    Ok(p) => p,
                    Err(e) => return Ok(err_json(e)),
                };

                // The command itself is arbitrary (that's the point of this tool), so
                // it's interpolated as-is into the `bash -lc` string the session runs.
                // There is no sandbox boundary around this any more - see this
                // module's doc comment and README.md's "Notes and limitations": a
                // `cargo build`/`cargo test` invocation already lets arbitrary code
                // run via build.rs/proc-macros/#[test]s, and this now runs with the
                // orchestrator process's own host privileges, not a container's.
                let hard_timeout = Duration::from_secs(args.timeout_secs.unwrap_or(ctx.config.command_timeout_secs));
                let idle_timeout = Duration::from_secs(ctx.config.shell_idle_timeout_secs);
                let result = match ctx.interactive_sessions.start(&cwd, &args.command, idle_timeout, hard_timeout).await {
                    Ok(r) => r,
                    Err(e) => return Ok(err_json(format!("failed to run command: {e}"))),
                };
                Ok(session_result_to_tool_output(&ctx, "shell", &args.command, result))
            })
        },
    )
}

fn shell_send_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "shell_send",
        "Send a line of input (as if typed, then Enter) to a still-open interactive command from a prior \
         shell or shell_send call that returned waiting_for_input: true. Returns the same shape shell does - \
         either exited: true with the final output, or another waiting_for_input: true with a new session_id \
         if it prompts again.",
        json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "string", "description": "The session_id from the shell/shell_send call this continues" },
                "input": { "type": "string", "description": "The answer to type, without a trailing newline - one is added automatically" }
            },
            "required": ["session_id", "input"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    session_id: String,
                    input: String,
                }
                let args: Args = parse_args(args)?;
                let hard_timeout = Duration::from_secs(ctx.config.command_timeout_secs);
                let idle_timeout = Duration::from_secs(ctx.config.shell_idle_timeout_secs);
                let result = match ctx.interactive_sessions.send(&args.session_id, &args.input, idle_timeout, hard_timeout).await {
                    Ok(r) => r,
                    Err(e) => return Ok(err_json(format!("failed to send input: {e}"))),
                };
                Ok(session_result_to_tool_output(&ctx, "shell_send", &args.input, result))
            })
        },
    )
}

/// Shared by `shell` and `shell_send`: logs the outcome and shapes a
/// [`crate::process::SessionResult`] into the JSON both tools return.
fn session_result_to_tool_output(
    ctx: &JobContext,
    tool: &str,
    command_or_input: &str,
    result: crate::process::SessionResult,
) -> ToolOutput {
    let output_tail = tail_chars(&result.output, 6000);
    ctx.log(
        tool,
        format!(
            "command={command_or_input:?} exited={} success={:?} waiting_for_input={} \n{output_tail}",
            result.exited,
            result.success,
            result.session_id.is_some()
        ),
    );
    if result.exited {
        ToolOutput::json(
            json!({ "success": result.success.unwrap_or(false), "exited": true, "output": output_tail }),
        )
    } else {
        ToolOutput::json(json!({
            "exited": false,
            "waiting_for_input": true,
            "session_id": result.session_id,
            "output": output_tail,
        }))
    }
}

/// Same truncation rule `ExecResult::combined_tail` uses, for the plain
/// output string an interactive session produces (both stdout and stderr
/// interleaved on the pty, exactly as a person would see them, rather than
/// kept separate). Rounds the cut point forward to the next valid UTF-8
/// char boundary, since an arbitrary byte offset into a `String` can
/// otherwise land inside a multi-byte character.
fn tail_chars(s: &str, max_chars: usize) -> String {
    if s.len() <= max_chars {
        return s.to_string();
    }
    let min_start = s.len() - max_chars;
    let start = (min_start..=s.len())
        .find(|&i| s.is_char_boundary(i))
        .unwrap_or(s.len());
    format!("[...truncated...]\n{}", &s[start..])
}

// ---------------------------------------------------------------------------
// todowrite
// ---------------------------------------------------------------------------

fn todowrite_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "todowrite",
        "Set/replace your own task list for this coding session - visible in the job log for a human \
         reviewing progress. Not required, but useful for a spec with several distinct steps: call it once \
         up front with your planned steps (status \"pending\"), then again as you start/finish each one. \
         Purely a visibility aid - has no effect on what you're allowed to do.",
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string" },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["todos"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Todo {
                    content: String,
                    status: String,
                }
                #[derive(Deserialize)]
                struct Args {
                    todos: Vec<Todo>,
                }
                let args: Args = parse_args(args)?;
                let summary = args.todos.iter().map(|t| format!("[{}] {}", t.status, t.content)).collect::<Vec<_>>().join("\n");
                ctx.log("todowrite", summary);
                Ok(ToolOutput::json(json!({ "success": true, "count": args.todos.len() })))
            })
        },
    )
}

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

pub(crate) fn ask_user_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "ask_user",
        "Ask the person who requested this canister a clarifying question, when the spec is genuinely \
         ambiguous and guessing wrong would waste real work (e.g. conflicting requirements, a missing \
         business rule with no reasonable default). Pauses this job until they answer, so use sparingly - \
         most gaps in a spec should be filled with a clearly-stated, reasonable assumption instead of a \
         question, since the answer often wouldn't change your approach anyway. If no one answers within \
         a while, you'll get a timeout instead of an answer - proceed with your best judgment when that \
         happens, and say in your final summary that clarification was sought but not received.",
        json!({
            "type": "object",
            "properties": {
                "question": { "type": "string", "description": "A single, specific, self-contained question - the person sees only this text, none of your other context." }
            },
            "required": ["question"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                #[derive(Deserialize)]
                struct Args {
                    question: String,
                }
                let args: Args = parse_args(args)?;
                let job_id = ctx.job_id();

                // Registered before `Job::ask` flips the state, so a
                // `POST /jobs/:id/answer` that lands the instant the state
                // becomes visible always finds a receiver already waiting -
                // never a window where the state says "awaiting" but
                // there's nothing yet to deliver an answer to.
                let receiver = ctx.jobs.register_pending_answer(&job_id);
                ctx.job.lock().unwrap().ask(args.question.clone());
                ctx.log("ask_user", format!("asking: {}", args.question));

                let timeout = Duration::from_secs(ctx.config.ask_user_timeout_secs);
                let outcome = tokio::time::timeout(timeout, receiver).await;

                // Unregister *before* resuming `Running`: a `submit_answer`
                // that arrives between these two calls should see "no
                // pending question" (this wait is already over, one way or
                // another) rather than a stale, alreday-consumed receiver.
                ctx.jobs.clear_pending_answer(&job_id);
                ctx.job.lock().unwrap().resume();

                match outcome {
                    Ok(Ok(answer)) => {
                        ctx.log("ask_user", format!("received answer: {answer}"));
                        Ok(ToolOutput::json(json!({ "success": true, "answer": answer })))
                    }
                    Ok(Err(_)) => {
                        // The sender was dropped without sending - shouldn't
                        // happen via the real HTTP endpoint (which always
                        // sends before dropping), but a possible outcome of
                        // `clear_pending_answer` racing a concurrent
                        // `submit_answer` that already removed the entry
                        // (see that method's own doc comment).
                        ctx.log("ask_user", "the pending question was cancelled without an answer");
                        Ok(err_json("no answer was received (the question was cancelled) - proceed with your best judgment"))
                    }
                    Err(_) => {
                        ctx.log("ask_user", format!("timed out after {}s with no answer", ctx.config.ask_user_timeout_secs));
                        Ok(err_json(format!(
                            "no answer was received within {}s - proceed with your best judgment rather than waiting further, and note in your final summary that clarification was sought but not received",
                            ctx.config.ask_user_timeout_secs
                        )))
                    }
                }
            })
        },
    )
}

#[cfg(test)]
mod resolve_path_tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/workspace/proj")
    }

    #[test]
    fn resolves_a_simple_relative_path() {
        assert_eq!(
            resolve_path(&root(), "src/lib.rs").unwrap(),
            root().join("src/lib.rs")
        );
    }

    #[test]
    fn empty_or_dot_resolves_to_the_project_root() {
        assert_eq!(resolve_path(&root(), "").unwrap(), root());
        assert_eq!(resolve_path(&root(), ".").unwrap(), root());
    }

    #[test]
    fn rejects_an_absolute_path() {
        assert!(resolve_path(&root(), "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_parent_directory_traversal() {
        assert!(resolve_path(&root(), "../secret").is_err());
        assert!(resolve_path(&root(), "src/../../secret").is_err());
    }

    #[test]
    fn affects_compilation_matches_rust_and_cargo_files_only() {
        assert!(affects_compilation(Path::new("src/lib.rs")));
        assert!(affects_compilation(Path::new("Cargo.toml")));
        assert!(affects_compilation(Path::new("Cargo.lock")));
        assert!(!affects_compilation(Path::new("README.md")));
        assert!(!affects_compilation(Path::new("service.did")));
    }
}
