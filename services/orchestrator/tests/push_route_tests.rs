//! Integration tests for the Web Push HTTP routes (`src/routes/push.rs`).
//! The orchestrator owns the HTTP surface, auth, and VAPID key config here,
//! but **persistence of the actual subscription records lives on
//! `backend`** (see `src/push.rs`'s doc comment and the `push_*` functions
//! in `src/ic/marketplace.rs`) - a controller-gated call the same shape as
//! `register_repo_publisher`.
//!
//! Splits into two kinds of coverage:
//! - `vapid_public_key`'s not-configured/configured branches and
//!   `subscribe`'s auth/validation checks never reach the agent-calling
//!   code at all, so those run against a plain in-process router (same
//!   style as `ask_user_route_tests.rs`/`github_connect_route_tests.rs`).
//! - The actual subscribe/unsubscribe/list round trip genuinely calls
//!   `backend` over a real agent, so those spin up a real PocketIC instance
//!   with `backend` installed and the orchestrator's own seed-phrase
//!   identity granted controller - same infrastructure
//!   `marketplace_search_and_deploy_tests.rs` already uses for its own
//!   real-canister coverage.
//!
//! Requires a built canister Wasm at
//! `../../backend/target/wasm32-unknown-unknown/release/backend.wasm` for
//! the second group - build it first:
//!
//!   cd ../../backend && IC_ENV=local cargo build --target wasm32-unknown-unknown --release
//!
//! and the real PocketIC server for both groups - see
//! `marketplace_search_and_deploy_tests.rs`'s own header comment for the
//! `POCKET_IC_BIN` note.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::Principal;
use hmac::{Hmac, Mac};
use orchestrator::auth::JwtCache;
use orchestrator::config::{Config, Redacted};
use orchestrator::job::JobStore;
use orchestrator::routes;
use orchestrator::state::AppState;
use pocket_ic::{PocketIc, PocketIcBuilder};
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

const BACKEND_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../backend/target/wasm32-unknown-unknown/release/backend.wasm"));

/// The same fixed test mnemonic `marketplace_search_and_deploy_tests.rs`
/// and `ic::agent::tests::seed_phrase_derivation_matches_dfx` use -
/// deterministic, so this file can derive the orchestrator's own principal
/// locally (no network call) and grant it `backend` controller at canister
/// creation time.
const ORCHESTRATOR_SEED_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn dummy_config(vapid_configured: bool) -> Config {
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
        require_auth: true,
        auth_network: "local".to_string(),
        github_oauth_client_id: None,
        github_oauth_client_secret: None,
        public_base_url: None,
        github_api_token: None,
        vapid_public_key: vapid_configured.then(|| URL_SAFE_NO_PAD.encode([4u8; 65])),
        vapid_private_key: vapid_configured.then(|| Redacted::for_test("unused-in-these-tests")),
    }
}

const JWT_SECRET: &[u8] = b"test-jwt-secret-only-used-in-this-file";

/// Mints a real HS256 JWT the exact way `src/auth.rs::verify_jwt` expects to
/// parse and verify one - this test file's stand-in for `backend`'s real
/// `issue_jwt`, since these tests run without a canister (or, in the second
/// group, without the frontend's own Internet Identity session).
fn mint_jwt(principal: Principal, expires_in_secs: u64) -> String {
    let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + expires_in_secs;
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::json!({ "sub": principal.to_text(), "exp": exp }).to_string());
    let signing_input = format!("{header}.{payload}");
    let mut mac = HmacSha256::new_from_slice(JWT_SECRET).unwrap();
    mac.update(signing_input.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{sig}")
}

async fn start_test_server(config: Config) -> String {
    let state = AppState {
        config: Arc::new(config),
        jobs: JobStore::default(),
        jwt_secret: Some(Arc::new(JWT_SECRET.to_vec())),
        jwt_cache: Arc::new(JwtCache::default()),
        github_connect: Arc::new(orchestrator::github::GithubConnectState::default()),
    };
    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

// ---------------------------------------------------------------------------
// Group 1: routes that never reach the agent-calling code - no PocketIC
// needed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn vapid_public_key_errors_clearly_when_not_configured() {
    let base_url = start_test_server(dummy_config(false)).await;
    let client = reqwest::Client::new();
    let response = client.get(format!("{base_url}/push/vapid-public-key")).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("VAPID_PUBLIC_KEY"), "got: {body}");
}

#[tokio::test]
async fn vapid_public_key_returns_the_raw_point_bytes_when_configured() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client.get(format!("{base_url}/push/vapid-public-key")).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    let key = body["key"].as_array().expect("key should be a byte array");
    assert_eq!(key.len(), 65, "a P-256 uncompressed SEC1 point is always 65 bytes: {body}");
}

#[tokio::test]
async fn subscribe_requires_a_signed_in_caller() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{base_url}/push/subscribe"))
        .json(&serde_json::json!({ "endpoint": "https://push.example/ep", "p256dh": "k", "auth": "a" }))
        .send()
        .await
        .unwrap();
    // No Authorization header at all - rejected by `AuthenticatedPrincipal`
    // itself (401), before `subscribe`'s own anonymous check or any agent
    // call ever runs.
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn subscribe_rejects_empty_fields() {
    let base_url = start_test_server(dummy_config(true)).await;
    let client = reqwest::Client::new();
    let token = mint_jwt(Principal::from_slice(&[7; 10]), 60);
    let response = client
        .post(format!("{base_url}/push/subscribe"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "endpoint": "  ", "p256dh": "k", "auth": "a" }))
        .send()
        .await
        .unwrap();
    // Rejected by `subscribe`'s own field validation, before any agent
    // call (which would otherwise fail anyway - no real network/identity
    // configured in `dummy_config`).
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Group 2: the real subscribe/unsubscribe/list round trip, through a real
// agent, against a real `backend` canister on a real (local) PocketIC
// instance.
// ---------------------------------------------------------------------------

struct RunningOrchestrator {
    base_url: String,
}

fn start_live_orchestrator(ic_url: &str, backend_id: Principal) -> RunningOrchestrator {
    let config = Config {
        require_auth: true,
        ic_url_local: ic_url.to_string(),
        marketplace_canister_id: backend_id,
        identity_seed_phrase: Some(Redacted::for_test(ORCHESTRATOR_SEED_PHRASE)),
        ..dummy_config(false)
    };

    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("failed to build the orchestrator router's runtime");
        rt.block_on(async move {
            let state = AppState {
                config: Arc::new(config),
                jobs: JobStore::default(),
                jwt_secret: Some(Arc::new(JWT_SECRET.to_vec())),
                jwt_cache: Arc::new(JwtCache::default()),
                github_connect: Arc::new(orchestrator::github::GithubConnectState::default()),
            };
            let app = routes::router(state);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("failed to bind the orchestrator router");
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.expect("orchestrator router crashed");
        });
    });
    let addr = addr_rx.recv_timeout(Duration::from_secs(10)).expect("orchestrator router failed to start");
    RunningOrchestrator { base_url: format!("http://{addr}") }
}

/// Spins up a real PocketIC instance, installs `backend` with the
/// orchestrator's own seed-phrase-derived principal as its controller (the
/// exact grant `push_subscribe`/`push_unsubscribe`/`push_list_subscriptions`
/// require), goes live, and starts a real orchestrator router pointed at
/// it. Returns the orchestrator's base URL; `pic` must stay alive for the
/// test's duration (dropping it tears down the replica).
fn setup_live_backend_and_orchestrator() -> (PocketIc, RunningOrchestrator) {
    let orchestrator_identity =
        orchestrator::ic::agent::identity_from_seed_phrase(ORCHESTRATOR_SEED_PHRASE).expect("failed to derive the orchestrator's own identity");
    let orchestrator_principal = orchestrator_identity.sender().expect("identity has no principal");

    let mut pic = PocketIcBuilder::new().with_application_subnet().build();
    let backend_id = pic.create_canister_with_settings(Some(orchestrator_principal), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(backend_id, BACKEND_WASM.to_vec(), candid::encode_one(()).unwrap(), Some(orchestrator_principal));

    let ic_url = pic.make_live(None).to_string();
    let running = start_live_orchestrator(&ic_url, backend_id);
    (pic, running)
}

// Plain `#[test]`, not `#[tokio::test]`, deliberately - same reason as
// `marketplace_search_and_deploy_tests.rs`'s own header comment: `PocketIc`'s
// API drives its own internal runtime via `block_on`, so the test's own
// control flow must stay synchronous (`reqwest::blocking`) to avoid nesting
// one Tokio runtime inside another. The orchestrator router still gets its
// own real runtime, on its own OS thread (`start_live_orchestrator`).

#[test]
fn subscribe_then_list_then_unsubscribe_round_trips_through_backend() {
    let (_pic, orchestrator) = setup_live_backend_and_orchestrator();
    let client = reqwest::blocking::Client::new();
    let token = mint_jwt(Principal::from_slice(&[9; 10]), 60);

    let subscribe_response = client
        .post(format!("{}/push/subscribe", orchestrator.base_url))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "endpoint": "https://push.example/ep-1", "p256dh": "k", "auth": "a" }))
        .send()
        .unwrap();
    let status = subscribe_response.status();
    assert_eq!(status, reqwest::StatusCode::OK, "{:?}", subscribe_response.text());

    let list_response: serde_json::Value = client
        .get(format!("{}/push/subscriptions", orchestrator.base_url))
        .bearer_auth(&token)
        .send()
        .unwrap()
        .json()
        .unwrap();
    let subscriptions = list_response["subscriptions"].as_array().unwrap();
    assert_eq!(subscriptions.len(), 1, "got: {list_response}");
    assert_eq!(subscriptions[0]["endpoint"], "https://push.example/ep-1");

    let unsubscribe_response = client
        .post(format!("{}/push/unsubscribe", orchestrator.base_url))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "endpoint": "https://push.example/ep-1" }))
        .send()
        .unwrap();
    assert_eq!(unsubscribe_response.status(), reqwest::StatusCode::OK);

    let list_after: serde_json::Value = client
        .get(format!("{}/push/subscriptions", orchestrator.base_url))
        .bearer_auth(&token)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(list_after["subscriptions"].as_array().unwrap().is_empty(), "got: {list_after}");
}

#[test]
fn two_callers_subscriptions_are_kept_separate_on_backend() {
    let (_pic, orchestrator) = setup_live_backend_and_orchestrator();
    let client = reqwest::blocking::Client::new();
    let alice = mint_jwt(Principal::from_slice(&[21; 10]), 60);
    let bob = mint_jwt(Principal::from_slice(&[22; 10]), 60);

    let response = client
        .post(format!("{}/push/subscribe", orchestrator.base_url))
        .bearer_auth(&alice)
        .json(&serde_json::json!({ "endpoint": "https://push.example/alice", "p256dh": "k", "auth": "a" }))
        .send()
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let bobs_list: serde_json::Value = client
        .get(format!("{}/push/subscriptions", orchestrator.base_url))
        .bearer_auth(&bob)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(bobs_list["subscriptions"].as_array().unwrap().is_empty(), "bob must not see alice's subscription: {bobs_list}");
}
