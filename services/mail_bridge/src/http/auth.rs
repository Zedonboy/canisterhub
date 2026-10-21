//! Authenticates `POST /send_mail`: a static bearer token
//! (`MAIL_BRIDGE_API_KEY`) every trusted canister's outbound HTTPS call is
//! expected to include, checked in constant time. See README.md's
//! "Authenticating outbound requests" section for why this is a shared
//! secret rather than something that verifies a specific caller's identity,
//! and how to swap in something stronger.

use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::Json;
use serde_json::{json, Value};

pub struct ApiKeyAuthenticated;

impl FromRequestParts<AppState> for ApiKeyAuthenticated {
    type Rejection = (StatusCode, Json<Value>);

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let unauthorized = |msg: &str| (StatusCode::UNAUTHORIZED, Json(json!({ "error": format!("unauthorized: {msg}") })));

        let header_value = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| unauthorized("missing Authorization header"))?;
        let token = header_value
            .strip_prefix("Bearer ")
            .ok_or_else(|| unauthorized("Authorization header must be 'Bearer <token>'"))?;

        if !constant_time_eq(token.as_bytes(), state.config.api_key.as_bytes()) {
            return Err(unauthorized("invalid token"));
        }
        Ok(ApiKeyAuthenticated)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
