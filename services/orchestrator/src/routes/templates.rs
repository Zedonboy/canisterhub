use crate::auth::AuthenticatedPrincipal;
use crate::ic::{agent, marketplace, types::MarketplaceItemType};
use crate::job::Job;
use crate::pipeline;
use crate::state::AppState;
use crate::templates::download_manifest;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

type ApiError = (StatusCode, Json<Value>);

#[derive(Deserialize)]
pub struct DeployRequest {
    #[serde(default = "local_network")]
    network: String,
    project_name: Option<String>,
}

fn local_network() -> String {
    "local".into()
}

pub async fn deploy_template(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Json(body): Json<DeployRequest>,
) -> Result<Json<Value>, ApiError> {
    if body.network != "local" && body.network != "ic" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "`network` must be `local` or `ic`"})),
        ));
    }

    let (ic_agent, _) = agent::build_agent_for_network(&state.config, &body.network, false)
        .await
        .map_err(internal_error)?;
    let item = marketplace::get_marketplace_item(
        &ic_agent,
        state.config.marketplace_canister_id,
        id,
    )
    .await
    .map_err(internal_error)?
    .ok_or_else(|| not_found("marketplace item not found"))?;
    if item.item_type != MarketplaceItemType::Template {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "marketplace item is not a template"})),
        ));
    }

    let http = reqwest::Client::new();
    let template = download_manifest(&http, &item.download_url)
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, Json(json!({"error": error}))))?;
    let project_name = body
        .project_name
        .unwrap_or_else(|| template.template.slug.clone());
    if project_name.is_empty()
        || project_name.len() > 64
        || !project_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "project_name must be a safe 1-64 character identifier"})),
        ));
    }

    let manifest = toml::to_string_pretty(&template).map_err(internal_error)?;
    let request = format!(
        "Deploy project template `{}` as project `{project_name}`. Treat this validated manifest as authoritative: deploy packages in dependency order, apply every configure step after all referenced canister IDs exist, resolve only the declared placeholders, and produce the declared environment values.\n\n{manifest}",
        template.template.name
    );
    let job_id = uuid::Uuid::new_v4().to_string();
    let job = Job::new(
        job_id.clone(),
        request,
        body.network,
        caller.to_text(),
        state.config.workspace_root.join(&job_id),
    );
    let handle = state.jobs.insert(job);
    pipeline::spawn(state.config.clone(), state.jobs.clone(), handle);
    Ok(Json(json!({
        "job_id": job_id,
        "marketplace_item_id": id,
        "template": template.template.slug,
        "project_name": project_name
    })))
}

fn internal_error(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(error = %error, "template marketplace request failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "template service is unavailable"})),
    )
}

fn not_found(message: &str) -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({"error": message})))
}
