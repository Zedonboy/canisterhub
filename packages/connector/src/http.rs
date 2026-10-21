//! The IC HTTP Gateway's candid interface (`http_request`/`http_request_update`)
//! and small helpers for working with it. These two record shapes and method
//! names are part of the IC interface spec itself, not a library - every
//! canister that wants to serve raw HTTP (as opposed to the certified-assets
//! recipe's static files) defines them exactly like this.
//!
//! A canister-security note baked into how this module is used (see
//! `lib.rs`): `http_request` is a query call, so its `Some(true)` `upgrade`
//! tells the boundary node to re-issue the same request as an update call to
//! `http_request_update` instead - only an update call goes through
//! consensus, so anything that mutates stable state (storing a webhook's
//! message) must happen there, not in the query handler.

use candid::CandidType;
use serde::Deserialize;

pub type HeaderField = (String, String);

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

impl HttpResponse {
    pub fn text(status_code: u16, body: impl Into<String>) -> Self {
        Self {
            status_code,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: body.into().into_bytes(),
            upgrade: None,
        }
    }

    pub fn not_found() -> Self {
        Self::text(404, "not found")
    }

    /// Tells the boundary node to re-issue this request against
    /// `http_request_update` - see this module's doc comment for why.
    pub fn upgrade_to_update() -> Self {
        Self { status_code: 200, headers: vec![], body: vec![], upgrade: Some(true) }
    }
}

/// Splits a request's `url` into its path and (still `&`-joined, still
/// percent-encoded) query string - `req.url` carries both, unlike an HTTP
/// library's already-parsed request object.
pub fn path_and_query(url: &str) -> (&str, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path, query),
        None => (url, ""),
    }
}

/// Looks up one `key=value` pair in a raw (`&`-joined) query string,
/// percent-decoding its value. `None` if `key` isn't present.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|pair| pair.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| percent_decode(v))
}

/// Looks up a header by name, case-insensitively (HTTP header names are
/// case-insensitive; WhatsApp/Telegram's own client libraries don't agree on
/// a casing convention).
pub fn header<'a>(headers: &'a [HeaderField], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// Minimal `application/x-www-form-urlencoded`-style percent-decoding, just
/// enough for query-string values (`+` is left as a literal `+`, unlike form
/// bodies, since this is only ever used on a URL's query string).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_query_splits_on_first_question_mark() {
        assert_eq!(path_and_query("/webhook/whatsapp?a=1&b=2"), ("/webhook/whatsapp", "a=1&b=2"));
        assert_eq!(path_and_query("/webhook/telegram"), ("/webhook/telegram", ""));
    }

    #[test]
    fn query_param_finds_and_decodes_values() {
        let q = "hub.mode=subscribe&hub.verify_token=my%20token&hub.challenge=123";
        assert_eq!(query_param(q, "hub.mode"), Some("subscribe".to_string()));
        assert_eq!(query_param(q, "hub.verify_token"), Some("my token".to_string()));
        assert_eq!(query_param(q, "hub.challenge"), Some("123".to_string()));
        assert_eq!(query_param(q, "missing"), None);
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let headers = vec![("X-Telegram-Bot-Api-Secret-Token".to_string(), "abc".to_string())];
        assert_eq!(header(&headers, "x-telegram-bot-api-secret-token"), Some("abc"));
        assert_eq!(header(&headers, "X-Missing"), None);
    }
}
