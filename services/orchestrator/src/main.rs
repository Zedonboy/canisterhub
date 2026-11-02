use ic_agent::Agent;
use orchestrator::config::Config;
use orchestrator::job::JobStore;
use orchestrator::state::AppState;
use orchestrator::{auth, ic, routes};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("orchestrator=info".parse()?),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    tokio::fs::create_dir_all(&config.workspace_root).await?;

    // One startup agent, on whichever replica hosts backend/hnsw_index
    // (`AUTH_NETWORK`), covers both one-time setup steps below. A real
    // identity is required regardless of `REQUIRE_AUTH`: bootstrapping the
    // hnsw_index collection needs one either way (see its own doc comment).
    let (startup_agent, _principal) = ic::agent::build_agent_for_network(&config, &config.auth_network, true)
        .await
        .map_err(|e| anyhow::anyhow!("{e} (DEPLOY_IDENTITY_PEM must be set - even a read-only setup needs a real identity to search hnsw_index)"))?;
    // Used only for the two one-time setup calls right below - the
    // orchestrator has no ongoing need for a `backend`/`hnsw_index` agent
    // past startup (it never reads or writes a `Project` record - see the
    // `decouple-orchestrator-api` project notes), so this doesn't need to
    // outlive `main` in `AppState`.
    tracing::info!("ensuring hnsw_index's marketplace_items collection exists...");
    ic::hnsw::ensure_marketplace_items_collection(&startup_agent, config.hnsw_canister_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e} (does DEPLOY_IDENTITY_PEM's identity have access to hnsw_index? see hnsw_index/README.md)"))?;

    let jwt_secret = if config.require_auth {
        tracing::info!("fetching JWT signing key from the backend canister (REQUIRE_AUTH=true)...");
        Some(Arc::new(
            bootstrap_jwt_secret(&config, &startup_agent).await?,
        ))
    } else {
        tracing::warn!(
            "REQUIRE_AUTH=false: /orchestrate and /jobs/:id are open to any caller, no Internet \
             Identity token required — do not run this way outside local development"
        );
        None
    };

    tracing::info!(
        bind_addr = %config.bind_addr,
        llm_provider = %config.llm_provider,
        marketplace_canister_id = %config.marketplace_canister_id,
        hnsw_canister_id = %config.hnsw_canister_id,
        require_auth = config.require_auth,
        "starting canister_hub Orchestration Agent"
    );

    let state = AppState {
        config: config.clone(),
        jobs: JobStore::default(),
        jwt_secret,
        jwt_cache: Arc::new(auth::JwtCache::default()),
        github_connect: Arc::new(orchestrator::github::GithubConnectState::default()),
    };
    let app = routes::router(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// One-time startup call to `backend`'s controller-only `get_jwt_signing_key`
/// (see `ic::jwt`) - `startup_agent`'s identity must be a controller of
/// `MARKETPLACE_CANISTER_ID` for this to succeed.
async fn bootstrap_jwt_secret(config: &Config, startup_agent: &Agent) -> anyhow::Result<Vec<u8>> {
    ic::jwt::fetch_jwt_signing_key(startup_agent, config.marketplace_canister_id).await
}
