//! Integration tests for the "Connect Git" HTTP routes
//! (`src/routes/github_connect.rs` / `src/github.rs`). Covers everything
//! reachable without a real GitHub OAuth App or network access - input
//! validation and the "not configured" error paths on `start`, and the
//! failure-reporting HTML page on `callback` for an unknown/expired `state`
//! and for GitHub's own `error` redirect param. The real
//! code-exchange/repo-permission/canister-call path needs a live GitHub App
//! + a real `backend` canister, so it isn't covered here - see
//! `backend/tests/marketplace_tests.rs`'s `register_repo_publisher` tests
//! for the canister-side half of this contract.
//!
//! Same harness as `ask_user_route_tests.rs`: a real `axum::Router` bound to
//! a real `TcpListener`, driven with real HTTP calls.

use candid::Principal;
use orchestrator::auth::JwtCache;
use orchestrator::config::{Config, Redacted};
use orchestrator::github::GithubConnectState;
use orchestrator::job::JobStore;
use orchestrator::routes;
use orchestrator::state::AppState;
use std::sync::Arc;

const TEST_REPO_URL: &str = "https://github.com/alice/cool-project";

fn dummy_config(github_configured: bool) -> Config {
    Config {
        bind_addr: "127.0.0.1:0".to_string(),
        workspace_root: std::env::temp_dir(),
        marketplace_canister_id: Principal::anonymous(),
        hnsw_canister_id: Principal::anonymous(),
        search_top_k: 5,
        search_relevance_threshold: 0.4,
        ic_url_local: "http://127.0.0.1:4943".to_string(),
        ic_url_mainnet: "https://ic0.app".to_string(),
        identity_seed_phrase: None,
        deploy_identity_pem: None,
        cycles_wallet_canister_id: None,
        canister_creation_cycles: 0,
        command_timeout_secs: 1,
        shell_idle_timeout_secs: 1,
        building_blocks_dir: std::env::temp_dir(),
        llm_provider: "openai".to_string(),
        llm_model: None,
        llm_max_turns: 1,
        llm_subagent_max_turns: 1,
        ask_user_timeout_secs: 1,
        ollama_tool_result_shim: true,
        icp_template_git: "unused".to_string(),
        icp_template_subfolder: "unused".to_string(),
        require_auth: false,
        auth_network: "local".to_string(),
        github_oauth_client_id: github_configured.then(|| "test-client-id".to_string()),
        github_oauth_client_secret: github_configured
            .then(|| Redacted::for_test("test-client-secret")),
        public_base_url: github_configured.then(|| "http://127.0.0.1:0".to_string()),
        github_api_token: None,
    }
}

async fn start_test_server(config: Config) -> String {
    let state = AppState {
        config: Arc::new(config),
        jobs: JobStore::default(),
        jwt_secret: None,
        jwt_cache: Arc::new(JwtCache::default()),
        github_connect: Arc::new(GithubConnectState::default()),
    };
    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn start_rejects_an_invalid_publisher_principal() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base_url}/github/connect/start"))
        .query(&[
            ("repo_url", TEST_REPO_URL),
            ("publisher", "not-a-principal"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("principal"));
}

#[tokio::test]
async fn start_rejects_the_anonymous_publisher_principal() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base_url}/github/connect/start"))
        .query(&[
            ("repo_url", TEST_REPO_URL),
            ("publisher", &Principal::anonymous().to_text()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("anonymous"));
}

/// Confirms the whole flow fails clearly, rather than panicking or silently
/// proceeding, when a deployment hasn't configured a GitHub OAuth App at
/// all - the expected state for most `orchestrator` deployments, since this
/// is an opt-in feature (see `Config::github_oauth_client_id`'s doc comment).
#[tokio::test]
async fn start_errors_clearly_when_github_oauth_is_not_configured() {
    let base_url = start_test_server(dummy_config(false)).await;
    let client = reqwest::Client::new();
    let publisher = Principal::from_slice(&[7; 10]);
    let response = client
        .get(format!("{base_url}/github/connect/start"))
        .query(&[
            ("repo_url", TEST_REPO_URL),
            ("publisher", &publisher.to_text()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("GITHUB_OAUTH_CLIENT_ID"),
        "got: {body}"
    );
}

#[tokio::test]
async fn start_rejects_a_non_github_repo_url() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let publisher = Principal::from_slice(&[7; 10]);
    let response = client
        .get(format!("{base_url}/github/connect/start"))
        .query(&[
            ("repo_url", "https://gitlab.com/alice/cool-project"),
            ("publisher", &publisher.to_text()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
}

/// The callback is hit directly by GitHub's own redirect (a plain browser
/// navigation into a popup), so it always returns 200 with an HTML page
/// reporting the outcome via `postMessage` - never a JSON error status -
/// even when the `state` token is unknown or expired.
#[tokio::test]
async fn callback_reports_failure_html_for_an_unknown_state() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base_url}/github/connect/callback"))
        .query(&[("code", "abc123"), ("state", "no-such-state-token")])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(content_type.starts_with("text/html"), "got: {content_type}");
    let body = response.text().await.unwrap();
    assert!(
        body.contains("canister-hub-github-connect"),
        "missing postMessage payload: {body}"
    );
    assert!(
        body.contains("\"success\":false"),
        "expected a failure result: {body}"
    );
}

#[tokio::test]
async fn callback_reports_a_github_denial_error() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base_url}/github/connect/callback"))
        .query(&[
            ("error", "access_denied"),
            ("error_description", "The user denied the request"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(body.contains("The user denied the request"), "got: {body}");
}
