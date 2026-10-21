//! Runs the REAL orchestrator HTTP router (same `orchestrator::routes::router`
//! the real binary serves - see `tests/ask_user_route_tests.rs` for the same
//! in-process technique, used there for the same reason: no real
//! `hnsw_index` bootstrap needed to exercise the HTTP layer itself) with
//! `REQUIRE_AUTH=true`, seeded with one real `Job` record for the
//! flight-booking app actually built and deployed locally by hand this
//! session (see the job's own `request`/`canisters` below - every id is
//! a real, independently-confirmed deployed principal, not fabricated).
//!
//! **The orchestrator never reads or writes `backend`'s `Project` record at
//! all** (see the `decouple-orchestrator-api` project notes) - the frontend
//! does that directly, as the real signed-in user. `REQUIRE_AUTH=true` still
//! matters here for a different reason: it's what makes `AuthenticatedPrincipal`
//! (see `orchestrator::auth`) actually verify the frontend's real JWT
//! (fetched from `backend::issue_jwt`) instead of treating every caller as
//! anonymous, so `Job::requested_by`/`answer_job`/`deploy_database`'s own
//! caller checks reflect the real signed-in principal. The `backend_agent`
//! below is used only once, at startup, to fetch `backend`'s real JWT
//! signing key (`ic::jwt::fetch_jwt_signing_key`) - requires a controller to
//! have called `init_jwt_signing_key` on `backend` once already (done for
//! this session's own deployment).
//!
//! This seeded in-memory job is not visible to the dashboard at all (it only
//! ever reads `backend::list_my_projects()`/`get_project`, and this job was
//! never written there) - it's only useful for exercising
//! `POST /jobs/:id/database/deploy`/`POST /jobs/:id/answer` directly against
//! its id without a full LLM pipeline run first.
use candid::Principal;
use ic_agent::{identity::AnonymousIdentity, Agent};
use orchestrator::auth::JwtCache;
use orchestrator::config::Config;
use orchestrator::job::{Job, JobState, JobStore};
use orchestrator::routes;
use orchestrator::state::AppState;
use std::sync::Arc;

fn dev_config() -> Config {
    Config {
        bind_addr: "0.0.0.0:8787".to_string(),
        workspace_root: std::env::temp_dir(),
        // The real `backend` canister on this session's local network - see
        // `local-dev-network-canister-ids` project notes. Confirm with
        // `icp canister status backend -i` if this network gets rebuilt.
        marketplace_canister_id: Principal::from_text("46el7-ql777-77775-aaada-cai").unwrap(),
        hnsw_canister_id: Principal::anonymous(),
        search_top_k: 5,
        search_relevance_threshold: 0.4,
        ic_url_local: "http://127.0.0.1:8000".to_string(),
        ic_url_mainnet: "https://ic0.app".to_string(),
        // The real orchestration pipeline (`pipeline::run`) needs a real,
        // non-anonymous identity for every job regardless of that job's
        // own network - it's used to search `hnsw_index`'s
        // `marketplace_items` collection, a privileged, single, fixed
        // deployment unrelated to which network a given job's own
        // canisters land on (see `ic::hnsw::ensure_marketplace_items_collection`'s
        // own doc comment). A well-known, standard BIP-39 test mnemonic -
        // the same one `ic::agent::tests::seed_phrase_derivation_matches_dfx`
        // and the real e2e test in `tests/marketplace_search_and_deploy_tests.rs`
        // already use and verify - not a secret, safe to hardcode in a dev
        // harness. This is unrelated to which network a *job* itself
        // deploys to - see `llm::coding_subagent_preamble`'s own
        // network-conditional deploy instructions for that (a real fix
        // that had to land before configuring any real identity here was
        // safe at all: a real identity plus the old unconditional `-e ic`
        // instructions would have deployed a "local" job to real mainnet).
        identity_seed_phrase: Some(orchestrator::config::Redacted::for_test(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )),
        deploy_identity_pem: None,
        cycles_wallet_canister_id: None,
        canister_creation_cycles: 0,
        command_timeout_secs: 600,
        shell_idle_timeout_secs: 20,
        // `../packages`, absolutized - matching the real fix in
        // `Config::from_env` - see its own comment on `building_blocks_dir`
        // for why both the relative value itself and leaving it relative
        // were real bugs, not style nits.
        building_blocks_dir: std::path::absolute("../packages").unwrap(),
        llm_provider: "ollama".to_string(),
        // `rig`'s Ollama client defaults to "llama3.2" when unset, which
        // this machine's real `ollama list` doesn't have pulled (confirmed
        // directly - a real job failed with a 404 "model not found" until
        // this was set). `qwen3.5:9b` is pulled and, per this session's own
        // verified findings (see the `ollama-tool-calling-reliability`
        // project notes), reliably chains real tool calls without needing
        // `OllamaToolResultShim` - matches `ollama_tool_result_shim: false`
        // below.
        llm_model: Some("qwen3.5:9b".to_string()),
        llm_max_turns: 24,
        llm_subagent_max_turns: 12,
        ask_user_timeout_secs: 1800,
        ollama_tool_result_shim: false,
        icp_template_git: "https://github.com/dfinity/icp-cli-templates".to_string(),
        icp_template_subfolder: "rust".to_string(),
        require_auth: true,
        auth_network: "local".to_string(),
        github_oauth_client_id: None,
        github_oauth_client_secret: None,
        public_base_url: None,
        github_api_token: None,
        vapid_public_key: None,
        vapid_private_key: None,
    }
}

#[tokio::main]
async fn main() {
    let jobs = JobStore::default();

    // The real job: built and deployed by hand this session, following the
    // exact same procedure `coding_subagent_preamble` describes - see the
    // conversation for the full real `icp new`/`icp build`/`icp deploy`/
    // `icp canister call update_config` transcript. `requested_by` is the
    // anonymous principal because this was done by hand directly (no real
    // `/orchestrate` caller at all) - unrelated to this server's own
    // `REQUIRE_AUTH` setting, and not itself visible via `list_my_projects`
    // regardless (see this file's own header comment: this in-memory job
    // was never written to `backend` at all).
    let mut job = Job::new(
        "fbef9034-c885-4d51-8559-75f89e6ced1a".to_string(),
        "I want to build a rudimentary Flight Booking Application - a simple, bare-bones version, not production-grade.".to_string(),
        "local".to_string(),
        Principal::anonymous().to_text(),
        std::path::PathBuf::from("data/jobs/fbef9034-c885-4d51-8559-75f89e6ced1a"),
    );
    job.set_project_name("flight-booking-fbef9034".to_string());
    job.add_canisters([
        ("backend".to_string(), "4caro-hl777-77775-aaaba-cai".to_string()),
        ("connector".to_string(), "46el7-ql777-77775-aaada-cai".to_string()),
        ("agent".to_string(), "4zfnl-5t777-77775-aaadq-cai".to_string()),
        ("admin_agent".to_string(), "4xhad-gd777-77775-aaacq-cai".to_string()),
        ("ic-sql".to_string(), "4fbx2-kt777-77775-aaabq-cai".to_string()),
        ("static".to_string(), "4qggx-l3777-77775-aaaca-cai".to_string()),
        // Added later, real deploys against this same running local project -
        // see the conversation: `vector_db` via the dashboard's own "Deploy
        // Database" button (verifying that real end-to-end pipeline),
        // `auth` via `icp new`/`build`/`deploy` by hand (verifying the new
        // `packages/auth` building block).
        ("vector_db".to_string(), "5uljf-s3777-77775-aaaea-cai".to_string()),
        ("auth".to_string(), "5tkpr-7d777-77775-aaaeq-cai".to_string()),
    ]);
    job.state = JobState::Succeeded;
    job.final_message = Some(
        "Built and deployed locally: connector, agent (search_flights/book_flight), admin_agent, ic-sql, static, vector_db, auth - wired together and independently verified via icp canister status."
            .to_string(),
    );

    // Same real generation `write_and_compile_project_tool`'s Mode-B success
    // path runs - called here directly (rather than simulated) against the
    // real deployed project directory, so this fetches each canister's
    // actual live `llm_context()` query, same as it would for a job that
    // went through the real pipeline. Requires the real local network to be
    // running with these canisters deployed (see this file's own header
    // comment) - if it isn't, this just logs to stderr and the seeded job's
    // `llm_context` stays `None`, same as any job that hasn't reached this
    // point yet.
    let project_dir = std::path::PathBuf::from("data/jobs/fbef9034-c885-4d51-8559-75f89e6ced1a/flight-booking-fbef9034");
    let canister_ids: serde_json::Map<String, serde_json::Value> =
        job.canisters.iter().map(|(name, info)| (name.clone(), serde_json::Value::String(info.id.clone()))).collect();
    let llm_context = orchestrator::llm::tools::generate_llm_context(
        job.project_name.as_deref().unwrap_or(&job.id),
        &job.request,
        &job.network,
        dev_config().command_timeout_secs,
        &project_dir,
        &canister_ids,
    )
    .await;
    if llm_context.lines().count() > 3 {
        job.set_llm_context(llm_context);
        println!("seeded job: generated a real llm_context ({} bytes) from the live local canisters", job.llm_context.as_ref().unwrap().len());
    } else {
        eprintln!("seeded job: local network/canisters not reachable right now - llm_context left unset");
    }

    jobs.insert(job);

    // Real agent against the real local replica - see this file's own
    // header comment for why anonymous is the right (not a placeholder)
    // identity here. Used only for the one-time JWT bootstrap right below -
    // the orchestrator has no ongoing need for a `backend` agent past
    // startup (see the `decouple-orchestrator-api` project notes).
    let backend_agent = Agent::builder().with_url("http://127.0.0.1:8000").with_identity(AnonymousIdentity).build().unwrap();
    backend_agent.fetch_root_key().await.expect("failed to fetch the local replica's root key - is `icp network start` running?");

    // `REQUIRE_AUTH=true` (see this file's own header comment) needs this
    // populated - same real `get_jwt_signing_key` call `main.rs`'s own
    // startup makes, just done here directly since this harness skips
    // `main.rs` entirely. Requires a controller to have already called
    // `init_jwt_signing_key` once (done for this session's own backend
    // deployment - anonymous, this agent's own identity, is a controller).
    let jwt_secret = orchestrator::ic::jwt::fetch_jwt_signing_key(&backend_agent, dev_config().marketplace_canister_id)
        .await
        .expect("failed to fetch backend's JWT signing key - has a controller called init_jwt_signing_key on it?");

    let state = AppState {
        config: Arc::new(dev_config()),
        jobs,
        jwt_secret: Some(Arc::new(jwt_secret)),
        jwt_cache: Arc::new(JwtCache::default()),
        github_connect: Arc::new(orchestrator::github::GithubConnectState::default()),
    };
    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8787").await.unwrap();
    println!("real orchestrator router listening on http://0.0.0.0:8787 (REQUIRE_AUTH=true, one seeded real job)");
    axum::serve(listener, app).await.unwrap();
}
