//! Shared helper for calling a deployed canister's own methods via `icp
//! canister call ... --json` - used by `llm::tools::generate_llm_context`
//! (each canister's own `llm_context`). The `ic-sql`-specific
//! `list_tables`/`describe_table`/`query`/`execute` helpers that used to
//! live here moved to the frontend (direct `@icp-sdk/core` calls) as part
//! of the project/canister-data split - see the architecture plan this
//! implements.
//!
//! `icp canister call`'s `--json` flag wraps the response in
//! `{"response_bytes": "...", "response_text": ..., "response_candid": "..."}` -
//! `response_candid` is the same pretty-printed Candid text format `icp
//! canister call` would otherwise print straight to a terminal, already
//! JSON-decoded into a plain string. Callers hand that string to
//! `candid_text::extract_text_reply`.

use crate::process;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Runs `icp canister call <name> <method> <args> --json` (adding `--query`
/// when `is_query` is set) and returns the `response_candid` field, or
/// `None` on any failure - network down, the canister doesn't actually have
/// this method, a non-zero exit, or output that doesn't parse as the
/// expected JSON envelope.
///
/// `args` is passed as a literal Candid-text argument (e.g. `"()"` for a
/// no-argument method) - **always pass it explicitly, never leave it for
/// the CLI to prompt for**: with an argument already given, `icp canister
/// call` skips its own interactive "build the arguments"/"do you want to
/// send this message?" confirmation entirely and just returns the clean
/// `--json` envelope (confirmed directly - undocumented, but real,
/// consistent behavior). Shell-quoted as a whole (single-quoted, with any
/// embedded `'` escaped) before being interpolated into the command
/// string.
pub async fn call_candid_text(project_dir: &Path, name: &str, method: &str, args: &str, is_query: bool, is_mainnet: bool, timeout: Duration) -> Option<String> {
    let quoted_args = shell_single_quote(args);
    let query_flag = if is_query { " --query" } else { "" };
    let command = if is_mainnet {
        format!("icp canister call {name} {method} {quoted_args}{query_flag} --json -e ic --identity deploy 2>&1")
    } else {
        format!("icp canister call {name} {method} {quoted_args}{query_flag} --json 2>&1")
    };
    let result = process::run(project_dir, &command, timeout).await.ok()?;
    if !result.success {
        return None;
    }
    let envelope = parse_json_envelope(&result.stdout)?;
    envelope.get("response_candid")?.as_str().map(str::to_string)
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'"'"'"#))
}

/// Parses `stdout` as the `--json` envelope. Tries the whole (trimmed)
/// output first - the normal case now that every call passes explicit
/// `args` and so never triggers the CLI's interactive preamble - falling
/// back to just the last non-empty line for defense in depth (real
/// observed shape from before every caller passed explicit args: the
/// envelope landing after several lines of "Please use the following
/// interactive prompt..."/"Do you want to send this message? [y/N]" text).
fn parse_json_envelope(stdout: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str(stdout.trim()) {
        return Some(v);
    }
    let json_line = stdout.lines().rev().find(|line| !line.trim().is_empty())?;
    serde_json::from_str(json_line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real captured `icp canister call ... --json` stdout from before every
    // caller passed explicit `args` (the interactive preamble this guards
    // against) - kept as a regression test for `parse_json_envelope`'s
    // fallback path even though the normal path no longer produces it.
    #[test]
    fn parse_json_envelope_falls_back_to_the_last_line_for_real_preamble_output() {
        let stdout = "Please use the following interactive prompt to build the arguments.\n\
                       Sending the following argument:\n\
                       ()\n\
                       \n\
                       Do you want to send this message? [y/N]\n\
                       {\"response_bytes\":\"44\",\"response_text\":null,\"response_candid\":\"(record { messages_processed = 0 : nat64 })\"}\n";
        let envelope = parse_json_envelope(stdout).unwrap();
        assert_eq!(envelope.get("response_candid").and_then(|v| v.as_str()), Some("(record { messages_processed = 0 : nat64 })"));
    }

    #[test]
    fn parse_json_envelope_reads_the_normal_clean_output_directly() {
        let stdout = "{\"response_bytes\":\"44\",\"response_text\":null,\"response_candid\":\"(vec { \\\"passengers\\\" })\"}\n";
        let envelope = parse_json_envelope(stdout).unwrap();
        assert_eq!(envelope.get("response_candid").and_then(|v| v.as_str()), Some("(vec { \"passengers\" })"));
    }

    #[test]
    fn shell_single_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_single_quote("SELECT * FROM t WHERE name = 'Bob'"), r#"'SELECT * FROM t WHERE name = '"'"'Bob'"'"''"#);
    }
}
