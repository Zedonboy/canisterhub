mod database;
mod github_connect;
mod health;
mod index_item;
mod jobs;
mod orchestrate;
mod push;
mod templates;

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
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    // `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/canisters`, `GET
    // /jobs/:id/database/canisters`, and the table/row CRUD routes are gone
    // (see routes/jobs.rs and routes/database.rs's own doc comments) - the
    // dashboard reads that data directly from `backend`/the canisters
    // themselves now. `deploy_database` stays: provisioning a new canister
    // still needs the orchestrator's local disk + `icp` CLI.
    Router::new()
        .route("/health", get(health::health))
        .route("/orchestrate", post(orchestrate::orchestrate))
        .route("/jobs/{id}/answer", post(jobs::answer_job))
        .route("/jobs/{id}/database/deploy", post(database::deploy_database))
        .route("/index_marketplace_item", post(index_item::index_marketplace_item))
        .route("/marketplace/items/{id}/template/deploy", post(templates::deploy_template))
        .route("/github/connect/start", get(github_connect::start))
        .route("/github/connect/callback", get(github_connect::callback))
        .route("/push/vapid-public-key", get(push::vapid_public_key))
        .route("/push/subscribe", post(push::subscribe))
        .route("/push/unsubscribe", post(push::unsubscribe))
        .route("/push/subscriptions", get(push::list_subscriptions))
        .layer(cors)
        .with_state(state)
}
