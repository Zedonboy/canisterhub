mod database;
mod github_connect;
mod health;
mod index_item;
mod jobs;
mod orchestrate;

use crate::state::AppState;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

pub fn router(state: AppState) -> Router {
    // Permissive by design: this API is meant to be called from a browser
    // frontend (see `frontend/src/lib/api.ts`) that may run on any origin/
    // port during local development, and there's no cookie-based session to
    // protect (auth, when `REQUIRE_AUTH=true`, is a bearer token in the
    // request itself, not an ambient credential CORS needs to gate). A
    // production deployment fronting this with a fixed, known frontend
    // origin should tighten this to that origin specifically.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/canisters`, `GET
    // /jobs/:id/database/canisters`, and the table/row CRUD routes are gone
    // (see routes/jobs.rs and routes/database.rs's own doc comments) - the
    // dashboard reads that data directly from `backend`/the canisters
    // themselves now. `deploy_database` stays: provisioning a new canister
    // still needs the orchestrator's local disk + `icp` CLI.
    //
    // `POST /marketplace/items/:id/template/deploy` is gone too (used to
    // spawn an LLM-agent job to deploy a project template's packages) -
    // template deploy is now entirely client-side (`frontend/src/lib/
    // templates.ts`): the browser installs each package directly via the
    // management canister, the same way `lib/deploy.ts` already does for a
    // single marketplace item, then drives each package's own
    // `ic::config` surface (`get_config_schema`/`set_config`) to apply the
    // manifest's declared defaults and prompt the user for anything still
    // required. No LLM, no orchestrator involvement.
    Router::new()
        .route("/health", get(health::health))
        .route("/orchestrate", post(orchestrate::orchestrate))
        .route("/jobs/{id}/answer", post(jobs::answer_job))
        .route(
            "/jobs/{id}/database/deploy",
            post(database::deploy_database),
        )
        .route(
            "/index_marketplace_item",
            post(index_item::index_marketplace_item),
        )
        .route("/github/connect/start", get(github_connect::start))
        .route("/github/connect/callback", get(github_connect::callback))
        .layer(cors)
        .with_state(state)
}
