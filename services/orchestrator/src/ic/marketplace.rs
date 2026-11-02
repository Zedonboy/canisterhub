use super::types::MarketplaceItem;
use candid::{Decode, Encode, Principal};
use ic_agent::Agent;

pub async fn list_marketplace_items(
    agent: &Agent,
    canister_id: Principal,
) -> anyhow::Result<Vec<MarketplaceItem>> {
    let arg = Encode!()?;
    let response = agent
        .query(&canister_id, "list_marketplace_items")
        .with_arg(arg)
        .call()
        .await?;
    let items = Decode!(&response, Vec<MarketplaceItem>)?;
    Ok(items)
}

pub async fn get_marketplace_item(
    agent: &Agent,
    canister_id: Principal,
    item_id: u64,
) -> anyhow::Result<Option<MarketplaceItem>> {
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
pub async fn record_download(
    agent: &Agent,
    canister_id: Principal,
    item_id: u64,
) -> anyhow::Result<()> {
    let arg = Encode!(&item_id)?;
    let response = agent
        .update(&canister_id, "record_download")
        .with_arg(arg)
        .call_and_wait()
        .await?;
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
    let response = agent
        .update(&canister_id, "register_repo_publisher")
        .with_arg(arg)
        .call_and_wait()
        .await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("register_repo_publisher failed: {e}"))
}
