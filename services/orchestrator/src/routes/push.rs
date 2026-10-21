//! `GET /push/vapid-public-key`, `POST /push/subscribe`,
//! `POST /push/unsubscribe`, `GET /push/subscriptions` - the Web Push HTTP
//! surface and auth (this orchestrator owns both), backed by `backend` as
//! the actual persistence layer (see `src/push.rs`'s own doc comment and
//! `src/ic/marketplace.rs`'s `push_*` functions).

use crate::auth::AuthenticatedPrincipal;
use crate::ic;
use crate::push::{decode_vapid_public_key, PushSubscription};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use candid::Principal;
use serde::Deserialize;
use serde_json::{json, Value};

type ApiError = (StatusCode, Json<Value>);

fn not_configured() -> ApiError {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "push notifications are not configured on this server - VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are unset" })),
    )
}

fn bad_gateway(e: anyhow::Error) -> ApiError {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() })))
}

/// Builds an agent under the orchestrator's own controller identity - every
/// handler below calls this, the same requirement
/// `register_repo_publisher`'s own caller has (see that function's doc
/// comment on `backend` for why).
async fn backend_agent(state: &AppState) -> Result<(ic_agent::Agent, Principal), ApiError> {
    let (agent, _principal) = ic::agent::build_agent_for_network(&state.config, &state.config.auth_network, true)
        .await
        .map_err(bad_gateway)?;
    Ok((agent, state.config.marketplace_canister_id))
}

/// The raw 65-byte uncompressed SEC1 P-256 point the browser's
/// `PushManager.subscribe({ applicationServerKey })` expects directly. Not
/// secret; no auth required.
pub async fn vapid_public_key(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let key = decode_vapid_public_key(&state.config).ok_or_else(not_configured)?;
    Ok(Json(json!({ "key": key })))
}

#[derive(Deserialize)]
pub struct SubscribeRequest {
    endpoint: String,
    p256dh: String,
    auth: String,
}

/// Records (or updates) the caller's own real browser subscription on
/// `backend`. Idempotent on `endpoint` - see `push_subscribe`'s own doc
/// comment in `src/ic/marketplace.rs`.
pub async fn subscribe(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Json(body): Json<SubscribeRequest>,
) -> Result<Json<Value>, ApiError> {
    if caller == Principal::anonymous() {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "sign in to subscribe to push notifications" }))));
    }
    if body.endpoint.trim().is_empty() || body.p256dh.trim().is_empty() || body.auth.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "endpoint, p256dh, and auth must not be empty" }))));
    }

    let (agent, canister_id) = backend_agent(&state).await?;
    let subscription = PushSubscription { endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth };
    ic::marketplace::push_subscribe(&agent, canister_id, caller, subscription).await.map_err(bad_gateway)?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct UnsubscribeRequest {
    endpoint: String,
}

/// Drops one of the caller's own subscriptions by `endpoint` on `backend`.
/// Not finding a match is not an error - the end state the caller wants is
/// already true.
pub async fn unsubscribe(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Json(body): Json<UnsubscribeRequest>,
) -> Result<Json<Value>, ApiError> {
    let (agent, canister_id) = backend_agent(&state).await?;
    ic::marketplace::push_unsubscribe(&agent, canister_id, caller, &body.endpoint).await.map_err(bad_gateway)?;
    Ok(Json(json!({ "success": true })))
}

/// The caller's own currently-stored subscriptions, read from `backend` -
/// lets the Settings page show accurate "enabled" state even on a device
/// other than the one that originally subscribed.
pub async fn list_subscriptions(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
) -> Result<Json<Value>, ApiError> {
    let (agent, canister_id) = backend_agent(&state).await?;
    let subscriptions = ic::marketplace::push_list_subscriptions(&agent, canister_id, caller).await.map_err(bad_gateway)?;
    Ok(Json(json!({ "subscriptions": subscriptions })))
}
