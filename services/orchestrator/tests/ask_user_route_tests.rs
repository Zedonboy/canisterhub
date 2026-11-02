//! Integration test for the `ask_user` pause/resume flow's HTTP half:
//! `POST /jobs/:id/answer` resolving a pending question - the plumbing
//! `llm/codetools.rs::ask_user_tool` depends on to actually reach a human,
//! exercised here exactly as that tool exercises it
//! (`JobStore::register_pending_answer`/`Job::ask`/`Job::resume`), but with
//! a plain spawned task standing in for the tool call itself rather than a
//! real LLM turn. Job state itself is observed directly from the shared
//! `JobStore` (not via `GET /jobs/:id`, which moved off the orchestrator
//! entirely as part of the project/canister-data split - see the
//! architecture plan this implements; the dashboard now reads project
//! state from `backend` directly instead) - this test cares about the real
//! HTTP `answer` route and the channel plumbing behind it, not about how a
//! caller happens to observe state.
//!
//! Deliberately does **not** go through a real `search_marketplace`/
//! `write_and_compile_project` run to reach a genuine `ask_user` call - that
//! would need a real LLM, not available in every environment this test
//! needs to run in. What's actually new and worth testing here is the
//! *plumbing* (`JobStore`'s channel bookkeeping and the real HTTP route) -
//! covered thoroughly, for real, without that dependency.
//!
//! Builds the real `axum::Router` in-process (`orchestrator::routes::router`)
//! and drives its `answer` route with real HTTP calls to a real bound
//! `TcpListener` - not a `tower::Service::oneshot`-style call, so this
//! exercises the exact same request path a real caller would, just without
//! spawning the compiled binary as a subprocess (which would need
//! `main.rs`'s own startup - a real IC agent, `hnsw_index` bootstrapping -
//! none of which `answer_job` itself touches). This only works because
//! `orchestrator` has a `src/lib.rs` exposing these modules - see that
//! file's doc comment.

use candid::Principal;
use orchestrator::auth::JwtCache;
use orchestrator::config::Config;
use orchestrator::job::{Job, JobState, JobStore};
use orchestrator::routes;
use orchestrator::state::AppState;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Every field is a harmless placeholder - `get_job`/`answer_job` (the only
/// handlers this test exercises) don't read `Config` at all, so nothing
/// here needs to be a real network endpoint or a real principal.
fn dummy_config() -> Config {
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
        github_oauth_client_id: None,
        github_oauth_client_secret: None,
        public_base_url: None,
        github_api_token: None,
    }
}

async fn start_test_server(jobs: JobStore) -> String {
    let state = AppState {
        config: Arc::new(dummy_config()),
        jobs,
        jwt_secret: None,
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

/// Reproduces exactly what `ask_user_tool` does, minus the LLM call around
/// it: register the pending-answer channel, move the job into
/// `AwaitingAnswer`, await the answer (or the same timeout, though this
/// test's `dummy_config` sets it to 1s specifically so the timeout test
/// below doesn't need a slow test), then resume. Returns what the "tool
/// call" would have returned, over a channel the test can inspect.
fn spawn_fake_ask_user(
    jobs: JobStore,
    job_id: String,
    question: String,
    timeout: Duration,
) -> tokio::sync::oneshot::Receiver<Result<String, String>> {
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let receiver = jobs.register_pending_answer(&job_id);
        {
            let handle = jobs.get(&job_id).unwrap();
            handle.lock().unwrap().ask(question);
        }
        let outcome = tokio::time::timeout(timeout, receiver).await;
        jobs.clear_pending_answer(&job_id);
        {
            let handle = jobs.get(&job_id).unwrap();
            handle.lock().unwrap().resume();
        }
        let result = match outcome {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err("cancelled".to_string()),
            Err(_) => Err("timed out".to_string()),
        };
        let _ = result_tx.send(result);
    });
    result_rx
}

/// Snapshots `id`'s current state directly from the shared `JobStore` -
/// this test's replacement for the now-removed `GET /jobs/:id` (see this
/// file's own header comment).
fn get_job(jobs: &JobStore, id: &str) -> Job {
    jobs.get(id).unwrap().lock().unwrap().clone()
}

async fn wait_for_state(jobs: &JobStore, id: &str, want: JobState) -> Job {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let job = get_job(jobs, id);
        if job.state == want {
            return job;
        }
        if Instant::now() > deadline {
            panic!("job {id} never reached state {want:?}: last seen {job:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_pending_question_is_visible_in_the_job_store_and_answerable_via_post() {
    let jobs = JobStore::default();
    let job = Job::new(
        "job-1".to_string(),
        "request".to_string(),
        "local".to_string(),
        "anonymous".to_string(),
        std::env::temp_dir(),
    );
    jobs.insert(job);

    let base_url = start_test_server(jobs.clone()).await;
    let client = reqwest::Client::new();

    // Before anything asks a question, the job just looks like any other
    // running job - no pending_question value.
    let initial = get_job(&jobs, "job-1");
    assert_eq!(initial.state, JobState::Running);
    assert!(initial.pending_question.is_none());

    let outcome = spawn_fake_ask_user(
        jobs.clone(),
        "job-1".to_string(),
        "which network?".to_string(),
        Duration::from_secs(5),
    );

    let awaiting = wait_for_state(&jobs, "job-1", JobState::AwaitingAnswer).await;
    assert_eq!(awaiting.pending_question.as_deref(), Some("which network?"));

    let response: serde_json::Value = client
        .post(format!("{base_url}/jobs/job-1/answer"))
        .json(&json!({ "answer": "mainnet" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["success"], true);

    // The spawned "tool call" should have received exactly that answer...
    assert_eq!(outcome.await.unwrap(), Ok("mainnet".to_string()));

    // ...and the job should be visibly back to normal afterward.
    let resumed = wait_for_state(&jobs, "job-1", JobState::Running).await;
    assert!(resumed.pending_question.is_none());
}

#[tokio::test]
async fn answering_a_job_with_no_pending_question_is_a_conflict() {
    let jobs = JobStore::default();
    jobs.insert(Job::new(
        "job-1".to_string(),
        "request".to_string(),
        "local".to_string(),
        "anonymous".to_string(),
        std::env::temp_dir(),
    ));
    let base_url = start_test_server(jobs).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base_url}/jobs/job-1/answer"))
        .json(&json!({ "answer": "anything" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
}

#[tokio::test]
async fn answering_an_unknown_job_is_not_found() {
    let jobs = JobStore::default();
    let base_url = start_test_server(jobs).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base_url}/jobs/no-such-job/answer"))
        .json(&json!({ "answer": "anything" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_empty_answer_is_rejected_before_touching_the_pending_question() {
    let jobs = JobStore::default();
    jobs.insert(Job::new(
        "job-1".to_string(),
        "request".to_string(),
        "local".to_string(),
        "anonymous".to_string(),
        std::env::temp_dir(),
    ));
    let base_url = start_test_server(jobs.clone()).await;
    let client = reqwest::Client::new();

    let _outcome = spawn_fake_ask_user(
        jobs.clone(),
        "job-1".to_string(),
        "q?".to_string(),
        Duration::from_secs(5),
    );
    wait_for_state(&jobs, "job-1", JobState::AwaitingAnswer).await;

    let response = client
        .post(format!("{base_url}/jobs/job-1/answer"))
        .json(&json!({ "answer": "   " }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    // The question must still be pending - the empty answer must not have
    // been consumed by the channel before being rejected.
    let job = get_job(&jobs, "job-1");
    assert_eq!(job.state, JobState::AwaitingAnswer);
}

#[tokio::test]
async fn a_question_that_times_out_resumes_the_job_without_an_answer() {
    let jobs = JobStore::default();
    jobs.insert(Job::new(
        "job-1".to_string(),
        "request".to_string(),
        "local".to_string(),
        "anonymous".to_string(),
        std::env::temp_dir(),
    ));
    let base_url = start_test_server(jobs.clone()).await;
    let client = reqwest::Client::new();

    let outcome = spawn_fake_ask_user(
        jobs.clone(),
        "job-1".to_string(),
        "q?".to_string(),
        Duration::from_millis(50),
    );
    wait_for_state(&jobs, "job-1", JobState::AwaitingAnswer).await;

    // Nobody answers - the fake tool call's own short timeout above should
    // fire and resume the job on its own.
    let resumed = wait_for_state(&jobs, "job-1", JobState::Running).await;
    assert!(resumed.pending_question.is_none());
    assert_eq!(outcome.await.unwrap(), Err("timed out".to_string()));

    // An answer that arrives after the timeout has nothing to land on.
    let response = client
        .post(format!("{base_url}/jobs/job-1/answer"))
        .json(&json!({ "answer": "too late" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
}
