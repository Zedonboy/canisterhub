use candid::{Decode, Encode, Principal};
use ic_agent::Agent;

/// Fetches `backend`'s JWT signing key via its controller-only
/// `get_jwt_signing_key` query - the orchestrator's configured identity must be
/// a controller of that canister. Called once at startup and cached; verifying
/// a token afterwards is a local HMAC check, not a round trip to the canister.
pub async fn fetch_jwt_signing_key(agent: &Agent, canister_id: Principal) -> anyhow::Result<Vec<u8>> {
    let arg = Encode!()?;
    let response = agent.query(&canister_id, "get_jwt_signing_key").with_arg(arg).call().await?;
    let result = Decode!(&response, Result<Vec<u8>, String>)?;
    result.map_err(|e| {
        anyhow::anyhow!(
            "get_jwt_signing_key failed: {e} (is the orchestrator's DEPLOY_IDENTITY_PEM a controller of the backend \
             canister, and has a controller called init_jwt_signing_key on it?)"
        )
    })
}
