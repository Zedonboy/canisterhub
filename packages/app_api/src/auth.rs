//! Minimal client for the sibling `auth` canister. Keeping only the
//! `Authorization` wire shape here avoids linking another canister crate and
//! its exported entry points into this Wasm.

use crate::ApiError;
use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

const AUTH_CANISTER_ENV: &str = "PUBLIC_CANISTER_ID:auth";
const SESSION_TOKEN_LEN: usize = 64;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub profile_id: u64,
    pub principal: Option<Principal>,
}

fn auth_canister_id() -> Result<Principal, ApiError> {
    let value = ic_cdk::api::env_var_value(AUTH_CANISTER_ENV);
    Principal::from_text(&value).map_err(|_| {
        ApiError::AuthUnavailable(format!(
            "{AUTH_CANISTER_ENV} is missing or is not a canister principal; deploy auth and app_api in the same environment"
        ))
    })
}

async fn call<T: CandidType>(
    method: &'static str,
    arg: T,
) -> Result<Option<Authorization>, ApiError> {
    let auth_canister = auth_canister_id()?;
    let response = ic_cdk::call::Call::bounded_wait(auth_canister, method)
        .with_arg(arg)
        .await
        .map_err(|error| {
            ApiError::AuthUnavailable(format!("auth.{method} call failed: {error}"))
        })?;
    response.candid::<Option<Authorization>>().map_err(|error| {
        ApiError::AuthUnavailable(format!(
            "auth.{method} returned an incompatible response: {error}"
        ))
    })
}

pub async fn session(token: &str) -> Result<Authorization, ApiError> {
    // Auth issues 32 random bytes as lowercase hex. Reject malformed values
    // locally so arbitrary traffic cannot force an inter-canister call.
    if token.len() != SESSION_TOKEN_LEN || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::Unauthorized(
            "invalid bearer session token".to_string(),
        ));
    }
    call("authorize_session", token.to_string())
        .await?
        .ok_or_else(|| ApiError::Unauthorized("session token is invalid or expired".to_string()))
}
