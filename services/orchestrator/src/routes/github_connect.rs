//! `GET /github/connect/start` + `GET /github/connect/callback` - the
//! "Connect Git" flow (see `src/github.rs`'s module doc comment for the full
//! picture). `start` is called by the dashboard (JWT-authenticated) to get a
//! GitHub OAuth authorize URL; `callback` is hit directly by GitHub's own
//! redirect (a plain browser navigation - no bearer token to check), so it
//! authenticates the request a different way: only a `state` token minted by
//! `start` moments earlier is accepted at all, and it's single-use.

use crate::auth::AuthenticatedPrincipal;
use crate::github;
use crate::ic;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use candid::Principal;
use serde::Deserialize;
use serde_json::{json, Value};

type ApiError = (StatusCode, Json<Value>);

#[derive(Deserialize)]
pub struct StartQuery {
    pub repo_url: String,
    pub publisher: String,
}

/// Mints a pending claim and returns GitHub's own authorize URL for the
/// dashboard to open in a popup. Requires a valid dashboard JWT - anyone
/// could otherwise mint claims for repos they have no interest in (harmless
/// on its own, since nothing is registered until the *GitHub* side also
/// approves, but there's no reason to allow it).
pub async fn start(
    State(state): State<AppState>,
    AuthenticatedPrincipal(caller): AuthenticatedPrincipal,
    Query(query): Query<StartQuery>,
) -> Result<Json<Value>, ApiError> {
    let publisher = Principal::from_text(query.publisher.trim())
        .map_err(|e| bad_request(format!("publisher is not a valid principal: {e}")))?;
    if publisher == Principal::anonymous() {
        return Err(bad_request("publisher must not be the anonymous principal".to_string()));
    }

    let state_token = state.github_connect.start(caller, publisher, query.repo_url.clone());
    let authorize_url = github::authorize_url(&state.config, &query.repo_url, &state_token)
        .map_err(|e| bad_request(e.to_string()))?;

    Ok(Json(json!({ "authorize_url": authorize_url })))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Hit directly by GitHub's redirect after the user approves (or denies) the
/// OAuth App. Always responds with a small self-closing HTML page (this
/// loads inside the popup `start`'s `authorize_url` was opened in, never the
/// dashboard's own window) that posts the outcome back to
/// `window.opener` and closes itself - `PublisherSetup.tsx` listens for that
/// `message` event.
pub async fn callback(State(state): State<AppState>, Query(query): Query<CallbackQuery>) -> Response {
    match handle_callback(&state, query).await {
        Ok(git_repo_url) => result_page(true, &git_repo_url, None),
        Err(e) => {
            tracing::warn!(error = %e, "github connect callback failed");
            result_page(false, "", Some(e.to_string()))
        }
    }
}

async fn handle_callback(state: &AppState, query: CallbackQuery) -> anyhow::Result<String> {
    if let Some(error) = query.error {
        anyhow::bail!("{}", query.error_description.unwrap_or(error));
    }
    let code = query.code.ok_or_else(|| anyhow::anyhow!("missing code"))?;
    let state_token = query.state.ok_or_else(|| anyhow::anyhow!("missing state"))?;

    let (publisher, git_repo_url) = state
        .github_connect
        .take(&state_token)
        .ok_or_else(|| anyhow::anyhow!("this connection attempt has expired or was already used - click Connect Git again"))?;

    let access_token = github::exchange_code_for_token(&state.config, &code).await?;
    let has_admin_access = github::verify_repo_admin_access(&access_token, &git_repo_url).await?;
    if !has_admin_access {
        anyhow::bail!("the GitHub account you authorized does not have admin access to {git_repo_url}");
    }

    let (agent, _principal) = ic::agent::build_agent_for_network(&state.config, &state.config.auth_network, true).await?;
    ic::marketplace::register_repo_publisher(&agent, state.config.marketplace_canister_id, &git_repo_url, publisher).await?;

    Ok(git_repo_url)
}

fn result_page(success: bool, git_repo_url: &str, error: Option<String>) -> Response {
    let payload = json!({
        "type": "canister-hub-github-connect",
        "success": success,
        "repo_url": git_repo_url,
        "error": error,
    });
    let message = if success {
        format!("Connected {git_repo_url}. You can close this window.")
    } else {
        format!("Couldn't connect: {}", error.as_deref().unwrap_or("unknown error"))
    };
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Canister Hub</title></head>
<body style="font-family: system-ui, sans-serif; background: #0a0e1a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
<p>{message}</p>
<script>
  if (window.opener) {{
    window.opener.postMessage({payload}, "*");
  }}
  setTimeout(() => window.close(), 1500);
</script>
</body></html>"#,
        message = html_escape(&message),
        payload = payload,
    ))
    .into_response()
}

/// `message` is interpolated into the HTML body (not the `<script>` JSON
/// payload, which is already safely serialized by `serde_json`) - escape the
/// handful of characters that matter in that context. `git_repo_url`/`error`
/// only ever reach here after passing through `anyhow`/JSON serialization
/// already, but this is cheap insurance against ever rendering raw
/// GitHub-controlled text as HTML.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn bad_request(message: String) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
}
