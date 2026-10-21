use super::types::MarketplaceItem;
use crate::push::PushSubscription;
use candid::{Decode, Encode, Principal};
use ic_agent::Agent;

pub async fn list_marketplace_items(agent: &Agent, canister_id: Principal) -> anyhow::Result<Vec<MarketplaceItem>> {
    let arg = Encode!()?;
    let response = agent
        .query(&canister_id, "list_marketplace_items")
        .with_arg(arg)
        .call()
        .await?;
    let items = Decode!(&response, Vec<MarketplaceItem>)?;
    Ok(items)
}

pub async fn get_marketplace_item(agent: &Agent, canister_id: Principal, item_id: u64) -> anyhow::Result<Option<MarketplaceItem>> {
    let arg = Encode!(&item_id)?;
    let response = agent
        .query(&canister_id, "get_marketplace_item")
        .with_arg(arg)
        .call()
        .await?;
    let item = Decode!(&response, Option<MarketplaceItem>)?;
    Ok(item)
}

/// Best-effort: bumps an item's popularity counter after this orchestrator
/// deploys it. Callers should log and continue on error rather than fail the
/// whole deploy over a popularity counter.
pub async fn record_download(agent: &Agent, canister_id: Principal, item_id: u64) -> anyhow::Result<()> {
    let arg = Encode!(&item_id)?;
    let response = agent.update(&canister_id, "record_download").with_arg(arg).call_and_wait().await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("record_download failed: {e}"))
}

/// `register_repo_publisher` is controller-only (see `backend/src/lib.rs`'s
/// doc comment on it) - `agent`'s identity must itself be a controller of
/// `canister_id` for this to succeed, same requirement as
/// `ic::jwt::fetch_jwt_signing_key`. Called only from `src/github.rs`, after
/// it has independently verified via the GitHub API that the OAuth-
/// authenticated account administers `git_repo_url`.
pub async fn register_repo_publisher(
    agent: &Agent,
    canister_id: Principal,
    git_repo_url: &str,
    publisher: Principal,
) -> anyhow::Result<()> {
    let arg = Encode!(&git_repo_url.to_string(), &publisher)?;
    let response = agent.update(&canister_id, "register_repo_publisher").with_arg(arg).call_and_wait().await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("register_repo_publisher failed: {e}"))
}

/// Persists (or updates) `principal`'s push subscription on `backend` -
/// `backend` is a pure persistence layer for this feature (see
/// `src/push.rs`'s doc comment); `agent`'s identity must be a controller of
/// `canister_id`, same requirement as `register_repo_publisher` above, for
/// the same reason: only the orchestrator can prove which end-user
/// principal a real subscribe request came from (it already verified a JWT
/// before calling here).
pub async fn push_subscribe(
    agent: &Agent,
    canister_id: Principal,
    principal: Principal,
    subscription: PushSubscription,
) -> anyhow::Result<()> {
    let arg = Encode!(&principal, &subscription)?;
    let response = agent.update(&canister_id, "push_subscribe").with_arg(arg).call_and_wait().await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("push_subscribe failed: {e}"))
}

/// Drops one of `principal`'s push subscriptions by `endpoint` on `backend`.
pub async fn push_unsubscribe(agent: &Agent, canister_id: Principal, principal: Principal, endpoint: &str) -> anyhow::Result<()> {
    let arg = Encode!(&principal, &endpoint.to_string())?;
    let response = agent.update(&canister_id, "push_unsubscribe").with_arg(arg).call_and_wait().await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("push_unsubscribe failed: {e}"))
}

/// `principal`'s own currently-stored push subscriptions, from `backend`.
pub async fn push_list_subscriptions(agent: &Agent, canister_id: Principal, principal: Principal) -> anyhow::Result<Vec<PushSubscription>> {
    let arg = Encode!(&principal)?;
    let response = agent.query(&canister_id, "push_list_subscriptions").with_arg(arg).call().await?;
    let result = Decode!(&response, Result<Vec<PushSubscription>, String>)?;
    result.map_err(|e| anyhow::anyhow!("push_list_subscriptions failed: {e}"))
}
