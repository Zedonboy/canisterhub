//! `app_api`: a starting point for a conventional authenticated API backend.
//! It exposes the same resource operations through Candid and HTTP while
//! delegating identity validation to the sibling `auth` canister.
//!
//! Auth owns the Web2 registration/login flow, user records, and session
//! issuance. Protected Candid calls pass that session token explicitly;
//! HTTP gateway calls carry the same token in `Authorization: Bearer ...`.
//! This canister delegates validation to `auth` before reading or changing
//! application state. Replace the example `Item` resource and routes with
//! app-specific domain logic; keep the shared authorization boundary intact.

mod auth;
mod http;
mod state;

pub use auth::Authorization;
pub use http::{HttpRequest, HttpResponse};

use candid::CandidType;
use serde::{Deserialize, Serialize};

const MAX_NAME_BYTES: usize = 200;
const MAX_PAYLOAD_BYTES: usize = 8 * 1024;
pub(crate) const MAX_HTTP_BODY_BYTES: usize = 10 * 1024;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub status: String,
    pub service: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateItem {
    pub name: String,
    pub payload: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: u64,
    pub owner_profile_id: u64,
    pub name: String,
    pub payload: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum ApiError {
    Unauthorized(String),
    Forbidden(String),
    NotFound,
    InvalidInput(String),
    Conflict(String),
    AuthUnavailable(String),
    Internal(String),
}

impl ApiError {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Unauthorized(_) => 401,
            Self::Forbidden(_) => 403,
            Self::NotFound => 404,
            Self::InvalidInput(_) => 400,
            Self::Conflict(_) => 409,
            Self::AuthUnavailable(_) => 503,
            Self::Internal(_) => 500,
        }
    }
}

#[ic_cdk::query]
pub fn health() -> Health {
    Health {
        status: "ok".to_string(),
        service: "app_api".to_string(),
    }
}

#[ic_cdk::update]
async fn get_my_identity(session_token: String) -> Result<Authorization, ApiError> {
    auth::session(&session_token).await
}

#[ic_cdk::update]
async fn create_item(session_token: String, input: CreateItem) -> Result<Item, ApiError> {
    let authorization = auth::session(&session_token).await?;
    create_for(authorization.profile_id, input)
}

#[ic_cdk::update]
async fn list_my_items(session_token: String) -> Result<Vec<Item>, ApiError> {
    let authorization = auth::session(&session_token).await?;
    Ok(list_for(authorization.profile_id))
}

#[ic_cdk::update]
async fn delete_item(session_token: String, id: u64) -> Result<Item, ApiError> {
    let authorization = auth::session(&session_token).await?;
    delete_for(authorization.profile_id, id)
}

pub(crate) fn create_for(profile_id: u64, input: CreateItem) -> Result<Item, ApiError> {
    validate_input(&input)?;
    state::create(profile_id, input, ic_cdk::api::time())
}

pub(crate) fn list_for(profile_id: u64) -> Vec<Item> {
    state::list(profile_id)
}

pub(crate) fn delete_for(profile_id: u64, id: u64) -> Result<Item, ApiError> {
    state::delete(profile_id, id)
}

fn validate_input(input: &CreateItem) -> Result<(), ApiError> {
    if input.name.trim().is_empty() {
        return Err(ApiError::InvalidInput("name must not be empty".to_string()));
    }
    if input.name.len() > MAX_NAME_BYTES {
        return Err(ApiError::InvalidInput(format!(
            "name exceeds {MAX_NAME_BYTES} bytes"
        )));
    }
    if input.payload.len() > MAX_PAYLOAD_BYTES {
        return Err(ApiError::InvalidInput(format!(
            "payload exceeds {MAX_PAYLOAD_BYTES} bytes"
        )));
    }
    Ok(())
}

#[ic_cdk::query]
fn http_request(request: HttpRequest) -> HttpResponse {
    http::query(request)
}

#[ic_cdk::update]
async fn http_request_update(request: HttpRequest) -> HttpResponse {
    http::update(request).await
}

#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_resource_bounds() {
        assert!(validate_input(&CreateItem {
            name: "item".to_string(),
            payload: "data".to_string()
        })
        .is_ok());
        assert!(matches!(
            validate_input(&CreateItem {
                name: " ".to_string(),
                payload: String::new()
            }),
            Err(ApiError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_input(&CreateItem {
                name: "item".to_string(),
                payload: "x".repeat(MAX_PAYLOAD_BYTES + 1)
            }),
            Err(ApiError::InvalidInput(_))
        ));
    }
}
