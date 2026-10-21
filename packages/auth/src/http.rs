//! The IC HTTP Gateway's candid interface (`http_request`/`http_request_update`).
//! See `connector/src/http.rs`'s doc comment for the full explanation of why
//! both methods exist and why every state-mutating request must upgrade to
//! the update call. Duplicated here (not shared via a common crate) because
//! this whole package is a standalone template - see this crate's `README.md`.

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

    pub fn html(status_code: u16, body: impl Into<String>) -> Self {
        Self {
            status_code,
            headers: vec![(
                "content-type".to_string(),
                "text/html; charset=utf-8".to_string(),
            )],
            body: body.into().into_bytes(),
            upgrade: None,
        }
    }

    /// A `302 Found` sending the browser to `location` - how a completed
    /// OAuth login hands control back to `Config::frontend_redirect_url`
    /// (see `lib.rs::handle_oauth_callback`).
    pub fn redirect(location: &str) -> Self {
        Self {
            status_code: 302,
            headers: vec![("location".to_string(), location.to_string())],
            body: vec![],
            upgrade: None,
        }
    }

    pub fn not_found() -> Self {
        Self::text(404, "not found")
    }

    /// Tells the boundary node to re-issue this request against
    /// `http_request_update` - see this module's doc comment for why.
    pub fn upgrade_to_update() -> Self {
        Self {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        }
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
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| percent_decode(v))
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
        assert_eq!(
            path_and_query("/oauth/google/callback?code=abc&state=xyz"),
            ("/oauth/google/callback", "code=abc&state=xyz")
        );
        assert_eq!(
            path_and_query("/oauth/google/callback"),
            ("/oauth/google/callback", "")
        );
    }

    #[test]
    fn query_param_finds_and_decodes_values() {
        let q = "code=abc&state=my%20state&extra=1";
        assert_eq!(query_param(q, "code"), Some("abc".to_string()));
        assert_eq!(query_param(q, "state"), Some("my state".to_string()));
        assert_eq!(query_param(q, "missing"), None);
    }
}
