use crate::auth::AuthenticatedPrincipal;
use crate::job::Job;
use crate::pipeline;
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct OrchestrateRequest {
    /// Natural-language description of the canister the caller wants.
    pub request: String,
    /// "local" (default) or "ic" (mainnet).
    #[serde(default = "default_network")]
    pub network: String,
}

fn default_network() -> String {
    "local".to_string()
}

pub async fn orchestrate(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Json(body): Json<OrchestrateRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if body.request.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`request` must not be empty" })),
        ));
    }
    if body.network != "local" && body.network != "ic" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`network` must be \"local\" or \"ic\"" })),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let workspace_dir = state.config.workspace_root.join(&id);

    // No `backend` write here - the orchestrator never reads or writes a
    // `Project` record (see the `decouple-orchestrator-api` project notes).
    // This job's own in-memory tracking (`state.jobs`) is independent of
    // anything the frontend does on `backend` directly.
    let job = Job::new(
        id.clone(),
        body.request,
        body.network,
        caller.to_text(),
        workspace_dir,
    );
    let handle = state.jobs.insert(job);

    pipeline::spawn(state.config.clone(), state.jobs.clone(), handle);

    Ok(Json(json!({ "job_id": id })))
}
