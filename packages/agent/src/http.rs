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

    pub fn not_found() -> Self {
        Self::text(404, "not found")
    }

    /// Tells the boundary node to re-issue this request against
    /// `http_request_update` - see this module's doc comment.
    pub fn upgrade_to_update() -> Self {
        Self {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        }
    }
}

pub fn path_and_query(url: &str) -> (&str, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path, query),
        None => (url, ""),
    }
}

pub fn query_param(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, value)| {
            let bytes = value.as_bytes();
            let mut out = Vec::with_capacity(bytes.len());
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' && i + 2 < bytes.len() {
                    if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                        out.push(byte);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            String::from_utf8_lossy(&out).into_owned()
        })
}

/// Looks up a header by name, case-insensitively.
pub fn header<'a>(headers: &'a [HeaderField], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_query_splits_on_first_question_mark() {
        assert_eq!(
            path_and_query("/webhook/admin?a=1"),
            ("/webhook/admin", "a=1")
        );
        assert_eq!(path_and_query("/webhook/admin"), ("/webhook/admin", ""));
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let headers = vec![("X-Signature".to_string(), "abc".to_string())];
        assert_eq!(header(&headers, "x-signature"), Some("abc"));
        assert_eq!(header(&headers, "missing"), None);
    }
}
