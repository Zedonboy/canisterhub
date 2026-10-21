//! `POST /index_marketplace_item` - the publish-time half of semantic search
//! (see `services/orchestrator/README.md`'s "Semantic marketplace search" section and
//! `src/embeddings.rs`). Nothing on-chain pushes a notification when
//! `backend.publish_marketplace_item` succeeds, so whoever publishes (a
//! publisher's CI, or a frontend) is expected to call this right afterwards
//! with the new item's id.

use crate::auth::AuthenticatedPrincipal;
use crate::embeddings;
use crate::ic;
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct IndexItemRequest {
    pub item_id: u64,
}

pub async fn index_marketplace_item(
    State(state): State<AppState>,
    AuthenticatedPrincipal(_caller): AuthenticatedPrincipal,
    Json(body): Json<IndexItemRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let bad_gateway = |msg: String| (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg })));

    // A short-lived agent for this one request, on whichever network hosts
    // `backend`/`hnsw_index` - same setup `bootstrap_jwt_secret` uses at
    // startup, but this needs a fresh agent per call since it isn't held
    // anywhere between requests. Requires a real identity: inserting into
    // hnsw_index is a write.
    let (agent, _principal) = ic::agent::build_agent_for_network(&state.config, &state.config.auth_network, true)
        .await
        .map_err(|e| bad_gateway(format!("failed to set up IC agent: {e}")))?;

    let item = ic::marketplace::get_marketplace_item(&agent, state.config.marketplace_canister_id, body.item_id)
        .await
        .map_err(|e| bad_gateway(format!("failed to query the marketplace canister: {e}")))?;
    let Some(item) = item else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": format!("no marketplace item with id {}", body.item_id) }))));
    };

    let (summary, keywords) = embeddings::summarize_and_extract_keywords(&state.config, &item.description)
        .await
        .map_err(|e| bad_gateway(format!("summarization failed: {e}")))?;

    let embedding_text = embeddings::embedding_input(&item, &summary, &keywords);
    let vector = embeddings::embed_text(&embedding_text)
        .await
        .map_err(|e| bad_gateway(format!("embedding failed: {e}")))?;

    let node_id = ic::hnsw::insert(
        &agent,
        state.config.hnsw_canister_id,
        ic::hnsw::InsertRequest {
            collection_id: ic::hnsw::MARKETPLACE_ITEMS_COLLECTION_ID,
            vector,
            metadata: ic::hnsw::item_id_to_metadata(item.id),
        },
    )
    .await
    .map_err(|e| bad_gateway(format!("failed to index into hnsw_index: {e}")))?;

    Ok(Json(json!({
        "success": true,
        "item_id": item.id,
        "node_id": node_id,
        "summary": summary,
        "keywords": keywords,
    })))
}
