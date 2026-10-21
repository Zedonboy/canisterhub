//! End-to-end test: publish `ic-sql` as a marketplace item, then drive a
//! REAL running orchestrator HTTP router (`orchestrator::routes::router`,
//! the exact same one the real binary serves) against a REAL PocketIC-backed
//! `backend`/`hnsw_index`, to confirm its top-level agent
//! (`LLM_PROVIDER=deepseek`) actually finds the item via `search_marketplace`
//! and deploys it to the "local" network. This exercises the real wiring end
//! to end (`/index_marketplace_item`, `/orchestrate`, the real
//! `search_marketplace`/`deploy_marketplace_item` tools, a real `hnsw_index`
//! search, a real canister install via `ic-agent`) - not just the individual
//! pieces each already have their own unit/PocketIC tests for.
//!
//! **In-process, not a subprocess** (unlike an earlier version of this file):
//! now that the orchestrator never reads or writes a `backend::Project`
//! record and `GET /jobs/:id` is long gone (see the `decouple-orchestrator-api`
//! project notes), there's no HTTP-observable signal left for an external
//! subprocess-driving test to poll for job completion - the only real,
//! private signal is `JobStore` itself. So this test builds `Config`/
//! `AppState` directly (same style as `ask_user_route_tests.rs`'s
//! `dummy_config`) and serves the real router on its own OS thread with its
//! own Tokio runtime (`start_orchestrator` below - the same pattern
//! `start_mock_server` already uses, for the same reason: this test's own
//! control flow is synchronous, via `PocketIc`'s blocking API), keeping a
//! `JobStore` handle to poll directly. The trade-off, stated plainly: this no
//! longer exercises `main.rs`'s own startup/env-parsing, only the router's
//! real request-handling logic - `main.rs` itself has no logic of its own
//! worth an end-to-end test beyond what it already gets from being run by
//! hand throughout this project's development.
//!
//! Because `orchestrator`'s own LLM provider clients read `DEEPSEEK_API_KEY`/
//! `DEEPSEEK_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_BASE_URL` directly from
//! process-wide env vars at call time (see `llm/mod.rs`/`embeddings.rs` -
//! not plumbed through `Config` at all), and this file's tests would
//! otherwise run concurrently in the same test binary, `ENV_LOCK` below
//! serializes every test that sets them - never rely on Cargo's default test
//! parallelism to isolate env var mutation across tests in one binary.
//!
//! The LLM itself is mocked: a tiny local HTTP server stands in for both
//! DeepSeek's chat-completions endpoint and OpenAI's embeddings endpoint,
//! returning a scripted sequence of responses. This is deterministic and
//! free, and matches this project's existing convention of mocking LLM HTTP
//! responses rather than calling a real provider in a test (see e.g.
//! `agent`/`admin_agent`'s own PocketIC-mocked-outcall tests) -
//! no `DEEPSEEK_API_KEY`/`OPENAI_API_KEY` required to run this. The
//! embedding vectors returned for both indexing and searching are the exact
//! same fixed vector, guaranteeing cosine distance 0 (well within any
//! relevance threshold) without needing a real embedding model.
//!
//! Requires, built first:
//!   - `packages/ic-sql`: `cargo build --target wasm32-unknown-unknown --release`
//!   - `backend`: `cargo build --target wasm32-unknown-unknown --release`
//!   - `tests/fixtures/ic_hnsw.wasm` - the same prebuilt release
//!     `hnsw_index/canister.yaml` pins (a downloaded fixture, not source -
//!     see this crate's `.gitignore`):
//!     ```sh
//!     curl -sL -o tests/fixtures/ic_hnsw.wasm \
//!       https://github.com/Zedonboy/ic-hnsw/releases/download/build-20260429-190649-9d5a1c9/ic_hnsw.wasm
//!     ```
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic
//!
//! Plain `#[test]`, not `#[tokio::test]`, deliberately: `PocketIc`'s own API
//! is synchronous (it drives its own internal runtime via `block_on`
//! underneath - see the `pocket-ic` crate's source), the same way every
//! other PocketIC test in this repo is written. The parts of this test that
//! genuinely need an async runtime - the mock LLM server and the real
//! orchestrator router - each get their own, on their own OS thread (see
//! `start_mock_server`/`start_orchestrator` below), entirely decoupled from
//! the test's own (synchronous) control flow; HTTP calls *from* the test use
//! `reqwest::blocking`. This sidesteps ever nesting one Tokio runtime inside
//! another.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use candid::{encode_one, Principal};
use orchestrator::config::{Config, Redacted};
use orchestrator::ic::types::MarketplaceItemType;
use orchestrator::job::{Job, JobState, JobStore};
use orchestrator::routes;
use orchestrator::state::AppState;
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Serializes every test in this binary that mutates process-wide LLM
/// provider env vars - see this file's own header comment.
static ENV_LOCK: Mutex<()> = Mutex::new(());

const IC_SQL_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/ic-sql/target/wasm32-unknown-unknown/release/ic_sql.wasm"));
const BACKEND_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../backend/target/wasm32-unknown-unknown/release/backend.wasm"));
const HNSW_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ic_hnsw.wasm"));

/// The same fixed test mnemonic `orchestrator`'s own
/// `ic::agent::tests::seed_phrase_derivation_matches_dfx` unit test uses -
/// deterministic, so the orchestrator's own identity/principal (for
/// deploying/querying a job's canisters) is stable across runs. No
/// `backend` controller grant needed for this identity at all any more -
/// the orchestrator never calls anything controller-gated on `backend`
/// (see the `decouple-orchestrator-api` project notes); creating
/// `hnsw_index`'s collection or a new canister via provisional creation
/// needs no pre-existing permission either.
const ORCHESTRATOR_SEED_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

// ---------------------------------------------------------------------------
// Mock LLM + release-artifact server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MockLlmState {
    /// Scripted `/chat/completions` responses, consumed in order - one per
    /// completion request, across both the indexing summarizer's call and
    /// the top-level agent's own turns.
    completions: Arc<Mutex<VecDeque<Value>>>,
    ic_sql_wasm: Arc<Vec<u8>>,
}

async fn mock_chat_completions(State(state): State<MockLlmState>) -> Json<Value> {
    let response = state
        .completions
        .lock()
        .unwrap()
        .pop_front()
        .expect("mock LLM server received more /chat/completions requests than this test queued");
    Json(response)
}

async fn mock_embeddings(State(_state): State<MockLlmState>) -> Json<Value> {
    // A fixed, arbitrary vector - returned identically for both the
    // indexing call and the search call, guaranteeing cosine distance 0
    // between them regardless of what text was actually sent to embed.
    let vector: Vec<f64> = (0..1536).map(|i| if i % 7 == 0 { 1.0 } else { 0.0 }).collect();
    Json(json!({
        "object": "list",
        "data": [{ "object": "embedding", "index": 0, "embedding": vector }],
        "model": "text-embedding-3-small",
        "usage": { "prompt_tokens": 1, "total_tokens": 1 },
    }))
}

async fn mock_release_wasm(State(state): State<MockLlmState>) -> Vec<u8> {
    (*state.ic_sql_wasm).clone()
}

/// Starts the mock server on its own OS thread with its own dedicated Tokio
/// runtime (see this file's doc comment for why), and returns its base URL
/// plus the shared completions queue for the test to populate. The server
/// runs for the rest of the process's lifetime - fine for a one-shot test
/// binary, nothing shuts it down explicitly.
fn start_mock_server(ic_sql_wasm: Vec<u8>) -> (String, Arc<Mutex<VecDeque<Value>>>) {
    let completions: Arc<Mutex<VecDeque<Value>>> = Arc::new(Mutex::new(VecDeque::new()));
    let state = MockLlmState { completions: completions.clone(), ic_sql_wasm: Arc::new(ic_sql_wasm) };

    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("failed to build the mock LLM server's runtime");
        rt.block_on(async move {
            let app = Router::new()
                .route("/chat/completions", post(mock_chat_completions))
                .route("/embeddings", post(mock_embeddings))
                .route("/release/ic-sql.wasm", get(mock_release_wasm))
                .with_state(state);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("failed to bind mock LLM server");
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.expect("mock LLM server crashed");
        });
    });

    let addr = addr_rx.recv_timeout(Duration::from_secs(5)).expect("mock LLM server failed to start");
    (format!("http://{addr}"), completions)
}

/// A scripted final (non-tool-call) turn. `usage` is required by rig-core's
/// DeepSeek `CompletionResponse` (unlike its own `Usage` type's individual
/// fields, that outer field has no `#[serde(default)]`) - omitting it
/// entirely makes the whole response fail to deserialize, which rig-core
/// then silently reclassifies as a provider *error* envelope instead of a
/// clear "missing field" error, so this is easy to get wrong quietly.
fn assistant_text(content: &str) -> Value {
    json!({
        "id": "mock-completion",
        "model": "deepseek-v4-pro",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }],
        "usage": {},
    })
}

/// A scripted turn calling exactly one tool. Each tool call needs its own
/// `index` (mirroring the streaming-delta shape real OpenAI-compatible APIs
/// use even for a complete response) - rig-core's DeepSeek `ToolCall` type
/// requires it with no default, and omitting it fails deserialization the
/// same silent-reclassified-as-a-provider-error way an absent `usage` does
/// (see `assistant_text`'s doc comment) - confirmed by probing
/// `rig::providers::deepseek::CompletionResponse` directly with and without
/// it, rather than guessing from the error message alone.
fn assistant_tool_call(call_id: &str, tool_name: &str, arguments: &Value) -> Value {
    json!({
        "id": "mock-completion",
        "model": "deepseek-v4-pro",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{ "index": 0, "id": call_id, "type": "function", "function": { "name": tool_name, "arguments": arguments.to_string() } }],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": {},
    })
}

// ---------------------------------------------------------------------------
// Publishing `ic-sql` as a marketplace item (direct PocketIC calls - this is
// test setup, not part of what's under test) - mirrors
// `backend/tests/marketplace_tests.rs`'s own `claim_and_publish` helper.
//
// `register_repo_publisher` is controller-only now (GitHub ownership is
// verified off-chain by the orchestrator's real "Connect Git" OAuth flow -
// see `src/github.rs` - not by any HTTPS outcall the canister makes itself),
// so there is no canister-side challenge/response to mock here any more;
// `publish_ic_sql_item` below just registers as `admin`, the canister's own
// controller, same as `backend/tests/marketplace_tests.rs`'s `claim_and_publish`.
// ---------------------------------------------------------------------------

fn publish_ic_sql_item(pic: &PocketIc, backend_id: Principal, admin: Principal, publisher: Principal, release_download_url: &str) -> u64 {
    let repo_url = "https://github.com/canister-hub-test/ic-sql";
    // `register_repo_publisher` is controller-only - `admin` stands in for
    // the orchestrator here (it's the canister's installed controller, same
    // as `backend/tests/marketplace_tests.rs`'s own `claim_and_publish`).
    let (registered,): (Result<(), String>,) = update_candid_as(
        pic,
        backend_id,
        admin,
        "register_repo_publisher",
        (repo_url.to_string(), publisher),
    )
    .unwrap();
    registered.expect("register_repo_publisher should succeed");

    let (result,): (Result<u64, String>,) = update_candid_as(
        pic,
        backend_id,
        publisher,
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            repo_url.to_string(),
            "ic-sql".to_string(),
            "A tiny SQL database canister: execute/query take a SQL string and run it \
             directly against the canister's own state. Supports CREATE TABLE, INSERT, \
             SELECT, UPDATE, DELETE, DROP TABLE."
                .to_string(),
            release_download_url.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            "ic-sql".to_string(),
            vec![0x42u8; 32],
        ),
    )
    .unwrap();
    result.expect("publish_marketplace_item should succeed")
}

// ---------------------------------------------------------------------------
// Driving the real orchestrator router in-process - see this file's own
// header comment for why not a subprocess any more.
// ---------------------------------------------------------------------------

struct RunningOrchestrator {
    base_url: String,
    jobs: JobStore,
}

/// Builds a real `Config`/`AppState` directly (no env vars, no subprocess -
/// same style as `ask_user_route_tests.rs`'s `dummy_config`) and serves the
/// real `routes::router` on its own OS thread with its own Tokio runtime.
/// `llm_env` supplies everything provider-specific
/// (`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_BASE_URL`) -
/// these `Config` has no field for at all (`orchestrator`'s own provider
/// clients read them directly from the process environment - see this
/// file's header comment on `ENV_LOCK`), so they're still set via
/// `std::env::set_var` here, under the caller's `ENV_LOCK` guard.
#[allow(clippy::too_many_arguments)]
fn start_orchestrator(ic_url: &str, backend_id: Principal, hnsw_id: Principal, workspace_root: std::path::PathBuf, llm_provider: &str, llm_model: Option<&str>, ollama_tool_result_shim: bool, llm_env: &[(&str, &str)]) -> RunningOrchestrator {
    for (key, value) in llm_env {
        std::env::set_var(key, value);
    }

    let config = Arc::new(Config {
        bind_addr: "127.0.0.1:0".to_string(),
        workspace_root,
        marketplace_canister_id: backend_id,
        hnsw_canister_id: hnsw_id,
        search_top_k: 5,
        search_relevance_threshold: 0.4,
        ic_url_local: ic_url.to_string(),
        ic_url_mainnet: "https://ic0.app".to_string(),
        identity_seed_phrase: Some(Redacted::for_test(ORCHESTRATOR_SEED_PHRASE)),
        deploy_identity_pem: None,
        cycles_wallet_canister_id: None,
        // The real `Config::from_env()` default - this test genuinely
        // deploys a canister (unlike `ask_user_route_tests.rs`'s own
        // `dummy_config`, which never does), so it needs enough cycles to
        // actually install code, not a placeholder zero.
        canister_creation_cycles: 3_000_000_000_000,
        command_timeout_secs: 120,
        shell_idle_timeout_secs: 30,
        building_blocks_dir: std::env::temp_dir(),
        llm_provider: llm_provider.to_string(),
        llm_model: llm_model.map(str::to_string),
        llm_max_turns: 10,
        llm_subagent_max_turns: 10,
        ask_user_timeout_secs: 30,
        ollama_tool_result_shim,
        icp_template_git: "unused".to_string(),
        icp_template_subfolder: "unused".to_string(),
        require_auth: false,
        auth_network: "local".to_string(),
        github_oauth_client_id: None,
        github_oauth_client_secret: None,
        public_base_url: None,
        github_api_token: None,
        vapid_public_key: None,
        vapid_private_key: None,
    });

    let jobs = JobStore::default();
    let jobs_for_thread = jobs.clone();

    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("failed to build the orchestrator router's runtime");
        rt.block_on(async move {
            // Same one-time bootstrap `main.rs` does before ever serving a
            // request - real `search_marketplace` calls need this
            // collection to already exist (see `main.rs`'s own doc comment
            // on why even a read-only search needs a real identity for it).
            let (startup_agent, _) = orchestrator::ic::agent::build_agent_for_network(&config, &config.auth_network, true)
                .await
                .expect("failed to build the startup agent");
            orchestrator::ic::hnsw::ensure_marketplace_items_collection(&startup_agent, config.hnsw_canister_id)
                .await
                .expect("failed to ensure hnsw_index's marketplace_items collection exists");

            let state = AppState {
                config,
                jobs: jobs_for_thread,
                jwt_secret: None,
                jwt_cache: Arc::new(orchestrator::auth::JwtCache::default()),
                github_connect: Arc::new(orchestrator::github::GithubConnectState::default()),
            };
            let app = routes::router(state);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("failed to bind the orchestrator router");
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.expect("orchestrator router crashed");
        });
    });
    let addr = addr_rx.recv_timeout(Duration::from_secs(10)).expect("orchestrator router failed to start");

    RunningOrchestrator { base_url: format!("http://{addr}"), jobs }
}

/// Polls `JobStore` directly (see this file's header comment for why - no
/// `backend`/`GET /jobs/:id` left to observe this over HTTP) until the job
/// leaves `Running`.
fn poll_job(jobs: &JobStore, job_id: &str, timeout: Duration) -> Job {
    let deadline = Instant::now() + timeout;
    loop {
        let job = jobs.get(job_id).unwrap_or_else(|| panic!("orchestrator has no job {job_id} yet")).lock().unwrap().clone();
        if job.state != JobState::Running {
            return job;
        }
        if Instant::now() > deadline {
            panic!("job did not finish within {timeout:?}: {job:?}");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// Confirming the deployed canister is genuinely `ic-sql`
// ---------------------------------------------------------------------------

#[derive(candid::CandidType, candid::Deserialize, Debug)]
enum SqlValueMirror {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Boolean(bool),
}

/// Field-for-field identical to `ic-sql`'s own `QueryResult` candid type -
/// candid matches by shape, not by a shared Rust type (see
/// `agent/src/db.rs`'s doc comment for the same convention and
/// why: this test binary has no reason to depend on the `ic-sql` crate
/// itself for one struct).
#[derive(candid::CandidType, candid::Deserialize, Debug)]
struct QueryResultMirror {
    #[allow(dead_code)]
    columns: Vec<String>,
    #[allow(dead_code)]
    rows: Vec<Vec<SqlValueMirror>>,
    #[allow(dead_code)]
    rows_affected: u64,
    message: String,
}

// ---------------------------------------------------------------------------
// Shared setup: both tests below need the same PocketIC instance with
// `backend`/`hnsw_index` installed and `ic-sql` already published as a free
// marketplace item - they differ only in which LLM actually drives the
// agent from that point on.
// ---------------------------------------------------------------------------

struct MarketplaceSetup {
    pic: PocketIc,
    admin: Principal,
    backend_id: Principal,
    hnsw_id: Principal,
    item_id: u64,
    /// Serves the release wasm always; also serves scripted
    /// `/chat/completions`/`/embeddings` responses for whichever test
    /// populates `completions` and points a provider's base-url override at
    /// it - unused by a test that talks to a real LLM instead.
    mock_base_url: String,
    completions: Arc<Mutex<VecDeque<Value>>>,
}

fn setup_marketplace_with_ic_sql_item() -> MarketplaceSetup {
    let admin = test_principal(1);
    let publisher = test_principal(2);

    // PocketIC: deploy `backend` + `hnsw_index`, still in fully-manual-tick
    // mode (not live yet) - publishing below needs to mock a canister HTTP
    // outcall, which is easiest to reason about before `make_live` switches
    // the instance into auto-progress.
    let pic = PocketIcBuilder::new().with_test_threshold_keys_subnet().with_application_subnet().build();

    let backend_id = pic.create_canister_with_settings(Some(admin), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(backend_id, BACKEND_WASM.to_vec(), encode_one(()).unwrap(), Some(admin));

    let hnsw_id = pic.create_canister_with_settings(Some(admin), None);
    pic.add_cycles(hnsw_id, 30_000_000_000_000);
    pic.install_canister(hnsw_id, HNSW_WASM.to_vec(), encode_one(()).unwrap(), Some(admin));

    // Mock LLM/release server, started early - the release_download_url
    // published below needs to point at it.
    let (mock_base_url, completions) = start_mock_server(IC_SQL_WASM.to_vec());

    // Publish `ic-sql` as a free (non-gated) marketplace item.
    let release_url = format!("{mock_base_url}/release/ic-sql.wasm");
    let item_id = publish_ic_sql_item(&pic, backend_id, admin, publisher, &release_url);

    MarketplaceSetup { pic, admin, backend_id, hnsw_id, item_id, mock_base_url, completions }
}

// ---------------------------------------------------------------------------
// Test 1: mocked LLM (deterministic, free, no API key/local model needed)
// ---------------------------------------------------------------------------

#[test]
fn deepseek_agent_finds_and_deploys_the_published_ic_sql_marketplace_item() {
    let MarketplaceSetup { mut pic, admin, backend_id, hnsw_id, item_id, mock_base_url, completions } = setup_marketplace_with_ic_sql_item();

    // Go live: PocketIC's HTTP gateway is what the real orchestrator router
    // (driven purely over HTTP from here on) will treat as its local
    // replica.
    let ic_url = pic.make_live(None).to_string();
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // Queue the mocked LLM turns, in the exact order they'll actually be
    //    requested: the indexing summarizer's single-turn call, then the
    //    top-level agent's two tool-calling turns and its closing summary.
    {
        let mut queue = completions.lock().unwrap();
        queue.push_back(assistant_text(
            r#"{"summary": "A small SQL database canister - execute/query run SQL directly.", "keywords": ["sql", "database", "query"]}"#,
        ));
        queue.push_back(assistant_tool_call("call_1", "search_marketplace", &json!({ "query": "a canister that acts as a simple SQL database" })));
        queue.push_back(assistant_tool_call("call_2", "deploy_marketplace_item", &json!({ "item_id": item_id })));
        queue.push_back(assistant_text("Found a matching marketplace item (ic-sql) and deployed it."));
    }

    // 6. Start the real orchestrator router against the live PocketIC
    //    gateway and the mock LLM server.
    let workspace_root = std::env::temp_dir().join(format!("orchestrator-e2e-test-{}", uuid::Uuid::new_v4()));
    let orchestrator = start_orchestrator(
        &ic_url,
        backend_id,
        hnsw_id,
        workspace_root,
        "deepseek",
        None,
        true,
        &[
            ("DEEPSEEK_API_KEY", "mock-key"),
            ("DEEPSEEK_BASE_URL", &mock_base_url),
            ("OPENAI_API_KEY", "mock-key"),
            ("OPENAI_BASE_URL", &mock_base_url),
        ],
    );
    let client = reqwest::blocking::Client::new();

    // 7. Index the just-published item through the real endpoint: summarize
    //    (mocked completion) + embed (mocked) + hnsw_index.insert (real,
    //    over the live gateway).
    let index_response: Value = client
        .post(format!("{}/index_marketplace_item", orchestrator.base_url))
        .json(&json!({ "item_id": item_id }))
        .send()
        .expect("POST /index_marketplace_item failed")
        .json()
        .expect("bad JSON from /index_marketplace_item");
    assert_eq!(index_response["success"], true, "indexing failed: {index_response}");

    // 8. Ask the top-level agent - a real request over HTTP - for something
    //    only `ic-sql` should satisfy.
    let orchestrate_response: Value = client
        .post(format!("{}/orchestrate", orchestrator.base_url))
        .json(&json!({ "request": "I need a canister that acts as a simple SQL database I can run queries against.", "network": "local" }))
        .send()
        .expect("POST /orchestrate failed")
        .json()
        .expect("bad JSON from /orchestrate");
    let job_id = orchestrate_response["job_id"].as_str().expect("no job_id in /orchestrate's response").to_string();

    // 9. Poll the real in-process `JobStore` (see `poll_job`'s own doc
    //    comment) until it finishes, and confirm it actually found +
    //    deployed the item rather than falling back to writing a new one
    //    from scratch (which would still "succeed" in principle, but not
    //    prove search_marketplace/deploy_marketplace_item did their job) -
    //    `final_message`'s exact wording (set only by
    //    `deploy_marketplace_item_tool`'s own success path - see
    //    `llm/tools.rs`) is this test's proof of that.
    let job = poll_job(&orchestrator.jobs, &job_id, Duration::from_secs(30));
    assert_eq!(job.state, JobState::Succeeded, "job did not succeed: {job:?}");
    let final_message = job.final_message.as_deref().unwrap_or_default();
    assert!(final_message.contains("Deployed marketplace item"), "expected a deploy_marketplace_item-shaped final_message: {final_message:?}");
    // `deploy_marketplace_item` sets the legacy single-canister `canister_id`
    // field, not `canisters` (that map is only ever populated by the
    // building-block/`write_and_compile_project` flow - see `Job::canister_id`'s
    // own doc comment).
    let deployed_id = Principal::from_text(job.canister_id.as_deref().expect("no canister_id recorded on the job")).unwrap();

    // 10. Prove the deployed canister is genuinely `ic-sql`, not just "some
    //     canister id was returned" - call its own `execute` method for
    //     real, directly via PocketIC.
    let (result,): (Result<QueryResultMirror, String>,) = update_candid_as(&pic, deployed_id, admin, "execute", ("CREATE TABLE t (id INT)".to_string(),)).unwrap();
    let result = result.expect("the deployed canister doesn't behave like ic-sql (execute failed)");
    assert_eq!(result.message, "Table 't' created successfully");

    let (tables,): (Vec<String>,) = query_candid_as(&pic, deployed_id, admin, "list_tables", ()).unwrap();
    assert_eq!(tables, vec!["t".to_string()]);
}

// ---------------------------------------------------------------------------
// Test 1b: the top-level agent finishing with plain text and zero tool
// calls - a real, observed failure mode of a context-starved local model
// (see `llm::run_agent`'s own `num_ctx` doc comment) - must be recorded as
// a real failure, not a false "Succeeded" with nothing deployed. Reuses
// the same mocked-LLM harness as the test above; only the scripted
// response differs.
// ---------------------------------------------------------------------------

#[test]
fn a_final_answer_with_no_canisters_deployed_is_recorded_as_a_failure_not_a_false_success() {
    let MarketplaceSetup { mut pic, backend_id, hnsw_id, mock_base_url, completions, .. } = setup_marketplace_with_ic_sql_item();
    let ic_url = pic.make_live(None).to_string();
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // No search_marketplace/deploy_marketplace_item/scaffold_project call at
    // all - just confused, half-finished text, exactly the real shape a
    // context-starved model produced in practice (see the `pipeline::run`
    // fix this guards).
    {
        let mut queue = completions.lock().unwrap();
        queue.push_back(assistant_text(
            "The tool call appears to be planning but not completing yet. Let me continue with the approach that's being taken.",
        ));
    }

    let workspace_root = std::env::temp_dir().join(format!("orchestrator-e2e-test-{}", uuid::Uuid::new_v4()));
    let orchestrator = start_orchestrator(
        &ic_url,
        backend_id,
        hnsw_id,
        workspace_root,
        "deepseek",
        None,
        true,
        &[
            ("DEEPSEEK_API_KEY", "mock-key"),
            ("DEEPSEEK_BASE_URL", &mock_base_url),
            ("OPENAI_API_KEY", "mock-key"),
            ("OPENAI_BASE_URL", &mock_base_url),
        ],
    );
    let client = reqwest::blocking::Client::new();

    let orchestrate_response: Value = client
        .post(format!("{}/orchestrate", orchestrator.base_url))
        .json(&json!({ "request": "a simple todo list app with no login", "network": "local" }))
        .send()
        .expect("POST /orchestrate failed")
        .json()
        .expect("bad JSON from /orchestrate");
    let job_id = orchestrate_response["job_id"].as_str().expect("no job_id in /orchestrate's response").to_string();

    let job = poll_job(&orchestrator.jobs, &job_id, Duration::from_secs(30));
    assert_eq!(job.state, JobState::Failed, "a zero-canister finish must not be recorded as Succeeded: {job:?}");
    assert!(job.canisters.is_empty());
    let error = job.error.as_deref().unwrap_or_default();
    assert!(error.contains("without deploying any canister"), "expected the real pipeline::run error message, got: {error:?}");
}

// ---------------------------------------------------------------------------
// Test 2: a real local model, via a real Ollama server - not a simulation of
// model behavior, an actual one reasoning about the request.
// ---------------------------------------------------------------------------

/// `#[ignore]`d deliberately: unlike the test above, this calls a real
/// model, which is non-deterministic, slow on CPU-only inference, and only
/// meaningful on a machine that actually has Ollama running with the model
/// pulled. Not something to run on every `cargo test`/in CI; run by hand
/// with:
///
/// ```sh
/// ollama pull llama3.1:8b   # once
/// cargo test --test marketplace_search_and_deploy_tests -- --ignored --nocapture
/// ```
///
/// Embeddings still go through the mock server (`OPENAI_BASE_URL` override)
/// rather than a real OpenAI call - `embeddings::embed_text` is hardcoded to
/// OpenAI regardless of `LLM_PROVIDER` (see `embeddings.rs`'s doc comment),
/// and this test isn't about embeddings, it's about whether the *chat*
/// model - the one deciding which tools to call - can actually do the job
/// locally. Only `LLM_PROVIDER`/no base-url override differs from the
/// mocked test above; everything else (marketplace setup, assertions) is
/// identical.
///
/// Shared body for both real-Ollama tests below - they differ only in which
/// model they run and whether `OllamaToolResultShim` is enabled for it.
///
/// `shim_enabled: false` means `model` is expected to handle a genuine
/// `role: "tool"` message correctly *on its own* - verify that directly
/// (raw `POST /api/chat` probes, bypassing `rig`/orchestrator entirely)
/// before pointing this at a new model with `false`; a model that actually
/// needs the shim will fail here as soon as `search_marketplace`'s result
/// comes back, since nothing rewrites it. See `OllamaToolResultShim`'s doc
/// comment for the underlying limitation this works around and which
/// models are verified either way (`qwen2.5-coder:7b`/`llama3.1:8b` need
/// it; `qwen3`/`qwen3.5` don't).
fn run_real_ollama_scenario(model: &str, shim_enabled: bool) {
    let MarketplaceSetup { mut pic, admin, backend_id, hnsw_id, item_id, mock_base_url, .. } = setup_marketplace_with_ic_sql_item();

    let ic_url = pic.make_live(None).to_string();
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // No completions queue to populate - `LLM_PROVIDER=ollama` never talks
    // to the mock server for chat at all (`rig`'s Ollama client reads
    // `OLLAMA_API_BASE_URL`, defaulting to the real `localhost:11434`,
    // entirely independent of `OPENAI_BASE_URL` below). Only embeddings are
    // redirected to the mock.
    let workspace_root = std::env::temp_dir().join(format!("orchestrator-e2e-ollama-test-{}", uuid::Uuid::new_v4()));
    let orchestrator = start_orchestrator(
        &ic_url,
        backend_id,
        hnsw_id,
        workspace_root,
        "ollama",
        Some(model),
        shim_enabled,
        &[("OPENAI_API_KEY", "mock-key"), ("OPENAI_BASE_URL", &mock_base_url)],
    );
    // Not `Client::new()`: reqwest 0.13 defaults every connection to a 30s
    // `TCP_USER_TIMEOUT`, which a real model's genuinely-slow response
    // (no bytes flow on the socket while it's thinking) blows straight
    // through, killing the connection out from under a request the server
    // is still legitimately working on. Disabled here - not something the
    // mocked test above ever approaches, so it doesn't need this.
    let client = reqwest::blocking::Client::builder().tcp_user_timeout(None).build().unwrap();

    // Indexing also goes through the configured LLM_PROVIDER (the
    // summarizer step) - so this, too, is a real local-model call, not just
    // the `/orchestrate` step below.
    let index_response: Value = client
        .post(format!("{}/index_marketplace_item", orchestrator.base_url))
        .json(&json!({ "item_id": item_id }))
        .send()
        .expect("POST /index_marketplace_item failed")
        .json()
        .expect("bad JSON from /index_marketplace_item");
    assert_eq!(index_response["success"], true, "indexing failed: {index_response}");

    let orchestrate_response: Value = client
        .post(format!("{}/orchestrate", orchestrator.base_url))
        .json(&json!({ "request": "I need a canister that acts as a simple SQL database I can run queries against.", "network": "local" }))
        .send()
        .expect("POST /orchestrate failed")
        .json()
        .expect("bad JSON from /orchestrate");
    let job_id = orchestrate_response["job_id"].as_str().expect("no job_id in /orchestrate's response").to_string();

    // Real inference on CPU-only local hardware is slow across several
    // tool-calling turns - a generous timeout, not a tight one.
    let job = poll_job(&orchestrator.jobs, &job_id, Duration::from_secs(300));
    eprintln!("job:\n{job:#?}");
    assert_eq!(job.state, JobState::Succeeded, "job did not succeed: {job:?}");
    let final_message = job.final_message.as_deref().unwrap_or_default();
    assert!(final_message.contains("Deployed marketplace item"), "expected a deploy_marketplace_item-shaped final_message: {final_message:?}");
    let deployed_id = Principal::from_text(job.canister_id.as_deref().expect("no canister_id recorded on the job")).unwrap();

    let (result,): (Result<QueryResultMirror, String>,) = update_candid_as(&pic, deployed_id, admin, "execute", ("CREATE TABLE t (id INT)".to_string(),)).unwrap();
    let result = result.expect("the deployed canister doesn't behave like ic-sql (execute failed)");
    assert_eq!(result.message, "Table 't' created successfully");

    let (tables,): (Vec<String>,) = query_candid_as(&pic, deployed_id, admin, "list_tables", ()).unwrap();
    assert_eq!(tables, vec!["t".to_string()]);
}

/// This test passes, but only because of `llm::ollama_tool_result_shim` -
/// worth understanding, since it's easy to "clean up" that module away
/// without realizing what breaks. Verified directly, bypassing `rig`/
/// orchestrator entirely (raw `POST /api/chat` probes against a real local
/// Ollama server): a *first* tool-calling turn (bare system+user history)
/// reliably populates Ollama's structured `message.tool_calls` field on
/// both `qwen2.5-coder:7b` and `llama3.1:8b` tried here - but a *second*
/// turn, once a `role: "tool"` message (a prior call's result) is anywhere
/// in the history, reliably does *not*: both models instead narrate the
/// intended call as JSON text inside `message.content` ("I will now call
/// deploy_marketplace_item... `{"name": "deploy_marketplace_item", ...}`"),
/// which - correctly, given what the API actually said - is not recognized
/// as a tool call. Feeding the same result back as a `role: "user"` message
/// instead (also verified the same way) reliably fixes it. `qwen2.5-coder`,
/// despite reporting a "tools" capability, doesn't populate `tool_calls`
/// even on the *first* turn, so it isn't used here at all; `llama3.1:8b`
/// does, reliably, which is why it's the one this test drives with the
/// shim enabled.
#[test]
#[ignore = "calls a real local Ollama model - slow, non-deterministic, needs `ollama pull llama3.1:8b` first; run with `cargo test -- --ignored`"]
fn llama31_agent_finds_and_deploys_the_published_ic_sql_marketplace_item_with_the_shim() {
    run_real_ollama_scenario("llama3.1:8b", true);
}

/// The `qwen3`/`qwen3.5` family handles a genuine `role: "tool"` message
/// correctly on its own (verified the same way as the bug above - 3/3
/// across repeated raw-API tries) - this drives the exact same scenario
/// with `OllamaToolResultShim` turned *off*, to confirm that holds end to
/// end through the real agent loop too, not just in isolated probes.
#[test]
#[ignore = "calls a real local Ollama model - slow, non-deterministic, needs `ollama pull qwen3.5:9b` first; run with `cargo test -- --ignored`"]
fn qwen35_agent_finds_and_deploys_the_published_ic_sql_marketplace_item_without_the_shim() {
    run_real_ollama_scenario("qwen3.5:9b", false);
}
