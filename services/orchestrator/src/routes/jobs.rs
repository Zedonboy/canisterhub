//! What's left of this module's original job-reporting surface after the
//! project/canister-data split (see the architecture plan this implements):
//! `GET /jobs`, `GET /jobs/:id`, and `GET /jobs/:id/canisters` are gone -
//! the dashboard now reads project state from `backend` directly
//! (`ic::backend`/`backend::get_project`/`list_my_projects`) and canister
//! stats directly from each canister, with no orchestrator HTTP call in
//! between. `answer_job` stays: it's the human-facing half of the
//! `ask_user` pause/resume flow, which needs the orchestrator's own live
//! in-process `oneshot` channel (see `job.rs`'s `JobStore`) - something no
//! canister can hold.

use crate::auth::AuthenticatedPrincipal;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct AnswerRequest {
    pub answer: String,
}

/// Answers a job's pending `ask_user` question (see
/// `llm/codetools.rs::ask_user_tool`) - the human-facing half of that
/// pause/resume flow. A job not currently in `AwaitingAnswer` (never asked
/// anything, already answered, or the wait already timed out) rejects this
/// with 409, same as any other state-conflict in this API - not 404, since
/// the job itself does exist.
pub async fn answer_job(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Path(id): Path<String>,
    Json(body): Json<AnswerRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let Some(handle) = state.jobs.get(&id) else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no such job" }))));
    };
    // Same visibility rule `get_canister_stats`/`get_job` used to (before
    // they moved to direct `backend`/canister calls): with `REQUIRE_AUTH=false`
    // every job shares the anonymous `requested_by`, so there's nothing
    // meaningful to isolate; otherwise a job is only answerable by whoever's
    // token created it.
    if state.jwt_secret.is_some() && handle.lock().unwrap().requested_by != caller.to_text() {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no such job" }))));
    }

    let answer = body.answer.trim().to_string();
    if answer.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "`answer` must not be empty" }))));
    }

    state.jobs.submit_answer(&id, answer).map_err(|e| (StatusCode::CONFLICT, Json(json!({ "error": e }))))?;
    Ok(Json(json!({ "success": true })))
}
