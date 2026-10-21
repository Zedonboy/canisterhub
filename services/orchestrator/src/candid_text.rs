//! Minimal parsing for `icp canister call ... --json`'s response envelope.
//!
//! That envelope (`{"response_bytes": "...", "response_text": ..., "response_candid": "..."}`)
//! already gives us `response_candid` as a plain, JSON-decoded string - the
//! same pretty-printed Candid text `icp canister call` prints to a
//! terminal, e.g. a single `text` return:
//! ```text
//! (
//!   "# connector\n\n## What this canister is\n..."
//! )
//! ```
//!
//! This is **not** a general Candid parser - it only handles the one shape
//! `llm::tools::generate_llm_context` needs (a single `text` value from a
//! canister's own `llm_context()` query). The `nat64`-record and
//! `ic-sql`-specific parsing this module used to also do (for
//! `routes::jobs::get_canister_stats`'s business stats and
//! `routes::database`'s table/row CRUD) moved to the frontend as part of
//! the project/canister-data split - see the architecture plan this
//! implements.

/// The string content of a single candid `text` return value - `(...)`
/// stripped, the outer quotes removed, and Candid's own backslash escapes
/// (`\n`, `\t`, `\r`, `\\`, `\"`, and `\xy` hex-byte escapes for anything
/// else) undone. `None` if `candid_text` doesn't look like a single quoted
/// string at all (e.g. it's a record, or call failed).
pub fn extract_text_reply(candid_text: &str) -> Option<String> {
    let inner = candid_text.trim().strip_prefix('(')?.strip_suffix(')')?.trim();
    // icp-cli's pretty-printer treats every return as a one-element tuple:
    // a short value stays on one line with no trailing comma
    // (`("hello")`), but once it wraps across lines (real observed case:
    // any `llm_context()` reply, which is always long) it renders a
    // trailing comma before the closing paren, same as a multi-line
    // record - `(\n  "...",\n)`. Strip it if present before looking for
    // the quotes.
    let inner = inner.strip_suffix(',').map(str::trim_end).unwrap_or(inner);
    let quoted = inner.strip_prefix('"')?.strip_suffix('"')?;
    Some(unescape_candid_string(quoted))
}

fn unescape_candid_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            // Candid's text-format escapes any other non-printable/non-ASCII
            // byte as `\xy` (two hex digits) - reconstruct the raw byte.
            // Only valid for single-byte (ASCII-range) escapes; a multi-byte
            // UTF-8 character escaped this way (one `\xy` per byte) would
            // need byte-level reassembly this simple char-by-char loop
            // doesn't do - not a shape our own canisters' `llm_context`
            // text actually produces, so left unhandled rather than
            // over-built for a case that doesn't occur.
            Some(h1) => {
                if let Some(h2) = chars.next() {
                    if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                        out.push(byte as char);
                        continue;
                    }
                    // Not actually a hex escape - keep both characters verbatim.
                    out.push(h1);
                    out.push(h2);
                } else {
                    out.push(h1);
                }
            }
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_reply_unwraps_a_simple_quoted_string() {
        assert_eq!(extract_text_reply("(\"hello\")").as_deref(), Some("hello"));
    }

    #[test]
    fn extract_text_reply_unescapes_newlines_and_quotes() {
        let raw = "(\n  \"line one\\nline two \\\"quoted\\\"\"\n)";
        assert_eq!(extract_text_reply(raw).as_deref(), Some("line one\nline two \"quoted\""));
    }

    #[test]
    fn extract_text_reply_strips_the_trailing_comma_a_long_pretty_printed_reply_gets() {
        // Real shape: every actual `llm_context()` reply is long enough that
        // icp-cli wraps it across lines and adds this trailing comma
        // (confirmed directly against a real `connector::llm_context()`
        // call - `extract_text_reply` silently returned `None` on this
        // exact shape before this test/fix existed).
        let raw = "(\n  \"# connector\\n\\nsome long body text\\n\",\n)";
        assert_eq!(extract_text_reply(raw).as_deref(), Some("# connector\n\nsome long body text\n"));
    }

    #[test]
    fn extract_text_reply_returns_none_for_a_record_not_a_string() {
        assert_eq!(extract_text_reply("(record { messages_processed = 0 : nat64 })"), None);
    }
}
