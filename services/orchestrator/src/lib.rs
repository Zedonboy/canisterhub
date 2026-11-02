//! Library half of this crate, split out from `main.rs` specifically so
//! integration tests under `tests/` can build the real `axum::Router`
//! in-process (`routes::router(state)`) and drive it with plain HTTP calls,
//! without needing the compiled binary as a subprocess or any of what
//! `main.rs` does at startup (an IC agent, `hnsw_index` bootstrapping) -
//! see `tests/ask_user_route_tests.rs` for exactly that. `main.rs` still
//! does all the same startup work it always did; it just does it by
//! calling into this library crate (`orchestrator::config::Config`, etc.)
//! instead of declaring these modules itself.

pub mod auth;
pub mod candid_text;
pub mod canister_query;
pub mod config;
pub mod embeddings;
pub mod github;
pub mod ic;
pub mod job;
pub mod llm;
pub mod pipeline;
pub mod process;
pub mod provenance;
pub mod routes;
pub mod state;
