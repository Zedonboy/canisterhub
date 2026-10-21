//! Database canister *provisioning* for a job's project - "add a Deploy
//! Database button, user is asked to choose which type(sql, vector etc)"
//! (the user's own framing). This is the one part of the old admin CRUD
//! viewer that stays server-side after the project/canister-data split (see
//! the architecture plan this implements): it needs a real `icp new`/
//! `build`/`deploy` run against this job's on-disk project workspace, which
//! only the orchestrator has. Everything else this module used to do -
//! listing a job's database canisters, browsing/editing their table data -
//! now happens as direct frontend-to-`ic-sql` calls instead (see
//! `frontend/src/lib/database.ts`), with no orchestrator HTTP call in
//! between.

use crate::auth::AuthenticatedPrincipal;
use crate::job::Job;
use crate::process;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

type ErrResponse = (StatusCode, Json<Value>);

/// Same visibility rule every other `/jobs/:id/...` route uses - see
/// `jobs::answer_job`'s doc comment.
fn authorize(state: &AppState, caller: &candid::Principal, job: &Job) -> Result<(), ErrResponse> {
    if state.jwt_secret.is_some() && job.requested_by != caller.to_text() {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no such job" }))));
    }
    Ok(())
}

fn load_job(state: &AppState, id: &str) -> Result<Job, ErrResponse> {
    let Some(handle) = state.jobs.get(id) else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no such job" }))));
    };
    let job = handle.lock().unwrap().clone();
    Ok(job)
}

#[derive(Deserialize)]
pub struct DeployDatabaseBody {
    /// "sql", "kv", or "vector" - the three real database building blocks
    /// this project has (`ic-sql`/`ic-kv`/`vector_db`), not the internal
    /// package directory name.
    kind: String,
}

/// Maps the frontend's own short kind names to the real `packages/`
/// subdirectory `icp new --path` copies from - see this module's own
/// `database_kind_package`'s callers for the exact command.
fn database_kind_package(kind: &str) -> Result<&'static str, ErrResponse> {
    match kind {
        "sql" => Ok("ic-sql"),
        "kv" => Ok("ic-kv"),
        "vector" => Ok("vector_db"),
        other => Err((StatusCode::BAD_REQUEST, Json(json!({ "error": format!("unknown database kind '{other}' - expected one of sql, kv, vector") })))),
    }
}

/// Picks a canister name that isn't already used in this job's
/// `icp.yaml`/`canisters` map - `package` itself if free, else
/// `<package>-2`, `<package>-3`, ... - so deploying a second `ic-sql`
/// alongside an existing one (exactly the "a user can have multiple
/// databases" case this module's own multi-canister scoping exists for)
/// doesn't collide with it.
fn free_canister_name(job: &Job, package: &str) -> String {
    if !job.canisters.contains_key(package) {
        return package.to_string();
    }
    (2..).map(|n| format!("{package}-{n}")).find(|name| !job.canisters.contains_key(name)).expect("unbounded range always yields a free name")
}

fn deploy_step_error(step: &str, result: &process::ExecResult) -> ErrResponse {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("{step} failed: {}", result.combined_tail(1000)) })))
}

fn execute_error(e: impl std::fmt::Display) -> ErrResponse {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() })))
}

/// Deploys one new database canister into this job's already-deployed
/// project - `POST /jobs/:id/database/deploy`, body `{"kind": "sql" |
/// "kv" | "vector"}` ("add a Deploy Database button, user is asked to
/// choose which type" - the user's own framing). Runs the exact same real
/// steps `coding_subagent_preamble` documents for adding one building
/// block by hand (`icp new --path` to copy the source, register it as a
/// bare entry in `icp.yaml`, `icp build`, `icp deploy`, then independently
/// confirm the real deployed id via `icp canister status -i`) - done
/// directly here rather than through the LLM pipeline, matching this
/// session's own established pattern for infrastructure actions that don't
/// need a model's judgment call.
///
/// Local network only for now: a mainnet deploy needs a real identity
/// imported into the project first (see `llm::tools::write_deploy_identity_file`)
/// which this endpoint doesn't yet do - attempting it returns a clear 501
/// rather than a confusing failure partway through.
pub async fn deploy_database(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Path(id): Path<String>,
    Json(body): Json<DeployDatabaseBody>,
) -> Result<Json<Value>, ErrResponse> {
    let job = load_job(&state, &id)?;
    authorize(&state, &caller, &job)?;
    let package = database_kind_package(&body.kind)?;

    if job.network == "ic" {
        return Err((StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "deploying a new canister to mainnet isn't supported from this button yet - use the full orchestrate flow" }))));
    }
    let Some(project_name) = &job.project_name else {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "this project hasn't finished deploying yet" }))));
    };
    let project_dir = job.workspace_dir.join(project_name);
    let timeout = Duration::from_secs(state.config.command_timeout_secs);
    let name = free_canister_name(&job, package);

    // 1. Copy the building block's real source in unchanged.
    let package_path = state.config.building_blocks_dir.join(package);
    let scaffold_cmd = format!("icp new {name} --path {} -s -o --vcs none 2>&1", package_path.display());
    let scaffold_result = process::run(&project_dir, &scaffold_cmd, timeout).await.map_err(execute_error)?;
    if !scaffold_result.success {
        return Err(deploy_step_error("icp new", &scaffold_result));
    }

    // 2. Register it in icp.yaml as a bare-path entry, same convention
    // every other building block in this project already uses. Appends at
    // EOF: every real project this session has produced has `canisters:`
    // as its one and only top-level key (confirmed directly - see
    // `llm::tools::parse_icp_yaml_canister_names`'s own doc comment), so
    // the end of the file is always inside that list.
    let icp_yaml_path = project_dir.join("icp.yaml");
    let mut icp_yaml = tokio::fs::read_to_string(&icp_yaml_path).await.map_err(|e| execute_error(format!("could not read icp.yaml: {e}")))?;
    if !icp_yaml.ends_with('\n') {
        icp_yaml.push('\n');
    }
    icp_yaml.push_str(&format!("  - {name}\n"));
    tokio::fs::write(&icp_yaml_path, icp_yaml).await.map_err(|e| execute_error(format!("could not update icp.yaml: {e}")))?;

    // 3. Build.
    let build_result = process::run(&project_dir, &format!("icp build {name} 2>&1"), timeout).await.map_err(execute_error)?;
    if !build_result.success {
        return Err(deploy_step_error("icp build", &build_result));
    }

    // 4. Deploy - none of the three database kinds take init args (see
    // `ic-sql`'s own doc comment on why its auth `Config` is deliberately
    // update_config-only rather than an init argument).
    let deploy_result = process::run(&project_dir, &format!("icp deploy {name} -y 2>&1"), timeout).await.map_err(execute_error)?;
    if !deploy_result.success {
        return Err(deploy_step_error("icp deploy", &deploy_result));
    }

    // 5. Independently confirm the real deployed id - never trust the
    // deploy step's own stdout for this (matches
    // `llm::tools::verify_deployed_canister_ids`'s own reasoning).
    let status_result = process::run(&project_dir, &format!("icp canister status {name} -i 2>&1"), timeout).await.map_err(execute_error)?;
    let new_id = status_result.stdout.trim().to_string();
    if !status_result.success || candid::Principal::from_text(&new_id).is_err() {
        return Err(deploy_step_error("icp canister status -i (verifying the deployed id)", &status_result));
    }

    let Some(handle) = state.jobs.get(&id) else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no such job" }))));
    };
    handle.lock().unwrap().add_canisters([(name.clone(), new_id.clone())]);

    // Add the real requesting user (proven by `AuthenticatedPrincipal`,
    // never a shared orchestrator deploy identity) as an additional
    // controller - see `process::add_controller`'s own doc comment.
    // Best-effort, logged loudly rather than failing this already-real
    // deploy: local network only here (checked above), so never `-e ic`.
    match process::add_controller(&project_dir, &name, &caller.to_text(), false, timeout).await {
        Ok(result) if result.success => {}
        Ok(result) => tracing::warn!(job_id = %id, canister = %name, "deploy_database: failed to add {caller} as a controller (non-fatal): {}", result.combined_tail(500)),
        Err(e) => tracing::warn!(job_id = %id, canister = %name, "deploy_database: failed to add {caller} as a controller (non-fatal): {e}"),
    }

    // No `backend` write here - the orchestrator never reads or writes a
    // `Project` record (see the `decouple-orchestrator-api` project notes).
    // The frontend records this new canister into `backend` itself, as the
    // real signed-in user, once this response comes back.
    Ok(Json(json!({ "name": name, "id": new_id, "kind": body.kind })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn job_with_canisters(pairs: impl IntoIterator<Item = (&'static str, &'static str)>) -> Job {
        let mut job = Job::new("j".to_string(), "req".to_string(), "local".to_string(), "requester".to_string(), PathBuf::new());
        job.add_canisters(pairs.into_iter().map(|(name, id)| (name.to_string(), id.to_string())));
        job
    }

    #[test]
    fn database_kind_package_maps_every_real_kind() {
        assert_eq!(database_kind_package("sql").unwrap(), "ic-sql");
        assert_eq!(database_kind_package("kv").unwrap(), "ic-kv");
        assert_eq!(database_kind_package("vector").unwrap(), "vector_db");
        assert!(database_kind_package("nope").is_err());
    }

    #[test]
    fn free_canister_name_uses_the_package_name_when_nothing_collides() {
        let job = job_with_canisters([("connector", "aaaaa-aa")]);
        assert_eq!(free_canister_name(&job, "ic-sql"), "ic-sql");
    }

    #[test]
    fn free_canister_name_numbers_past_a_real_collision() {
        // "a user can have multiple databases" - deploying a second
        // `ic-sql` alongside an existing one shouldn't collide with it.
        let job = job_with_canisters([("ic-sql", "aaaaa-aa")]);
        assert_eq!(free_canister_name(&job, "ic-sql"), "ic-sql-2");
    }

    #[test]
    fn free_canister_name_keeps_counting_past_several_collisions() {
        let job = job_with_canisters([("ic-sql", "aaaaa-aa"), ("ic-sql-2", "bbbbb-bb"), ("ic-sql-3", "ccccc-cc")]);
        assert_eq!(free_canister_name(&job, "ic-sql"), "ic-sql-4");
    }
}
