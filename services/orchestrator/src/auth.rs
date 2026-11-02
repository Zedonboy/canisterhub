//! Verifies the HS256 JWTs `backend`'s `issue_jwt` hands out to Internet
//! Identity-authenticated callers (see `backend/src/lib.rs`'s JWT section).
//! Verification is entirely local against a signing key fetched once at
//! startup (`ic::jwt::fetch_jwt_signing_key`) - no canister call per request.

use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::Principal;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;

type HmacSha256 = Hmac<Sha256>;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after 1970")
        .as_secs()
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum JwtError {
    #[error("malformed token")]
    Malformed,
    #[error("invalid signature")]
    BadSignature,
    #[error("token expired")]
    Expired,
    #[error("token subject is not a valid principal")]
    BadSubject,
}

/// Verifies `token` against `secret` (HS256) and returns the principal it was
/// issued to plus its expiry (unix seconds), so a caller can cache the result
/// until then. Does not call out to the canister - the caller already fetched
/// `secret` once via `ic::jwt::fetch_jwt_signing_key`.
pub fn verify_jwt(secret: &[u8], token: &str) -> Result<(Principal, u64), JwtError> {
    let mut parts = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(sig_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(JwtError::Malformed);
    };

    let signing_input = format!("{header_b64}.{payload_b64}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC-SHA256 accepts any key length");
    mac.update(signing_input.as_bytes());
    let expected_sig = mac.finalize().into_bytes();
    let given_sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| JwtError::Malformed)?;
    if !constant_time_eq(&given_sig, &expected_sig) {
        return Err(JwtError::BadSignature);
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| JwtError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&payload_bytes).map_err(|_| JwtError::Malformed)?;

    if unix_now() >= claims.exp {
        return Err(JwtError::Expired);
    }

    let principal = Principal::from_text(&claims.sub).map_err(|_| JwtError::BadSubject)?;
    Ok((principal, claims.exp))
}

/// Caches successfully-verified tokens (principal + expiry) so a caller
/// making repeated requests with the same bearer token - the expected case,
/// since a frontend calls `issue_jwt` once and reuses the result for up to an
/// hour - doesn't pay for an HMAC recompute + base64/JSON parse on every
/// request. Only ever populated by *valid* tokens: a rejected token is never
/// cached, so this can't turn a transient failure into a sticky one, and
/// there's no new attack surface from caching (an entry existing at all
/// already implies its signature checked out).
///
/// Not persisted anywhere and not shared across processes - just an
/// in-memory speedup, correct to lose on restart.
#[derive(Default)]
pub struct JwtCache(Mutex<HashMap<String, CachedClaim>>);

struct CachedClaim {
    principal: Principal,
    exp: u64,
}

/// Above this many distinct cached tokens, an insert first sweeps out
/// everything already expired - bounds this to roughly "one entry per
/// currently-valid session" instead of growing forever as different tokens
/// get issued over the process's lifetime.
const JWT_CACHE_SWEEP_AT_SIZE: usize = 1024;

impl JwtCache {
    /// Returns the cached principal if `token` is in the cache and hasn't
    /// passed its cached expiry yet.
    fn get(&self, token: &str) -> Option<Principal> {
        let cache = self.0.lock().unwrap();
        let cached = cache.get(token)?;
        (unix_now() < cached.exp).then_some(cached.principal)
    }

    fn insert(&self, token: String, principal: Principal, exp: u64) {
        let mut cache = self.0.lock().unwrap();
        if cache.len() >= JWT_CACHE_SWEEP_AT_SIZE {
            let now = unix_now();
            cache.retain(|_, cached| cached.exp > now);
        }
        cache.insert(token, CachedClaim { principal, exp });
    }
}

/// Avoids leaking signature-comparison timing as an oracle. Lengths differing
/// is itself safe to branch on - only byte content needs the constant-time
/// treatment.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Axum extractor: the caller's principal, proven by a valid
/// `Authorization: Bearer <jwt>` header. Rejects the request with 401 if it's
/// missing, malformed, expired, or badly signed - unless the server is
/// running with `REQUIRE_AUTH=false`, in which case every caller is treated
/// as the anonymous principal (see `Config::require_auth`'s doc comment).
pub struct AuthenticatedPrincipal(pub Principal);

impl FromRequestParts<AppState> for AuthenticatedPrincipal {
    type Rejection = (StatusCode, Json<Value>);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(secret) = &state.jwt_secret else {
            return Ok(AuthenticatedPrincipal(Principal::anonymous()));
        };

        let unauthorized = |msg: &str| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": format!("unauthorized: {msg}") })),
            )
        };

        let header_value = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| unauthorized("missing Authorization header"))?;
        let token = header_value
            .strip_prefix("Bearer ")
            .ok_or_else(|| unauthorized("Authorization header must be 'Bearer <token>'"))?;

        if let Some(principal) = state.jwt_cache.get(token) {
            return Ok(AuthenticatedPrincipal(principal));
        }

        let (principal, exp) =
            verify_jwt(secret, token).map_err(|e| unauthorized(&e.to_string()))?;
        state.jwt_cache.insert(token.to_string(), principal, exp);
        Ok(AuthenticatedPrincipal(principal))
    }
}
