use crate::auth::JwtCache;
use crate::config::Config;
use crate::github::GithubConnectState;
use crate::job::JobStore;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub jobs: JobStore,
    /// `backend`'s JWT signing key, fetched once at startup - `None` iff
    /// `Config::require_auth` is `false` (see `src/auth.rs`).
    pub jwt_secret: Option<Arc<Vec<u8>>>,
    /// Verified-token cache shared across requests - see `JwtCache`.
    pub jwt_cache: Arc<JwtCache>,
    /// Pending "Connect Git" OAuth attempts - see `src/github.rs`.
    pub github_connect: Arc<GithubConnectState>,
}
