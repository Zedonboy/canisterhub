//! GitHub OAuth-based repository-ownership verification - the "Connect Git"
//! flow in `PublisherSetup.tsx`.
//!
//! `backend::register_repo_publisher` is controller-only (see its own doc
//! comment): a bare authenticated caller can't prove they control a GitHub
//! repo, so the canister no longer trusts a self-reported claim at all. This
//! module is what the orchestrator - itself a controller of the backend
//! canister (see `ic::jwt::fetch_jwt_signing_key`'s identical requirement) -
//! uses to actually perform that verification, off-chain, with a real GitHub
//! OAuth App:
//!
//!   1. `start()` records what's being claimed (which dashboard principal,
//!      which CI `publisher` principal, which repo) under a random,
//!      short-lived `state` token and returns GitHub's own authorize URL.
//!   2. The dashboard opens that URL in a popup; the signed-in GitHub user
//!      approves (or doesn't) the OAuth App's access request.
//!   3. GitHub redirects the popup to our `/github/connect/callback` with a
//!      `code` + the same `state`. `exchange_code_for_token` trades that
//!      code for a real access token (requires the OAuth App's client
//!      secret - this exchange can only happen server-side), and
//!      `verify_repo_admin_access` confirms that token's account actually
//!      administers the claimed repo via GitHub's own API.
//!   4. Only then does the route handler call
//!      `ic::marketplace::register_repo_publisher` - using the
//!      orchestrator's own controller identity, never the dashboard
//!      caller's.
//!
//! No shared secret or nonce-in-a-release-note dance (the design this
//! replaces, which never actually got built - see `backend/backend.did`'s
//! git history) - GitHub's own OAuth flow *is* the proof.

use crate::config::Config;
use candid::Principal;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a `state` token stays claimable - generous for a human clicking
/// through a GitHub OAuth consent screen, short enough that an abandoned
/// attempt doesn't linger indefinitely.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

struct PendingConnect {
    /// The signed-in dashboard principal that initiated this - not itself
    /// checked against anything on the canister side (only `publisher`
    /// ends up recorded there), kept for logging/audit only.
    #[allow(dead_code)]
    dashboard_principal: Principal,
    publisher: Principal,
    git_repo_url: String,
    created_at: Instant,
}

/// In-memory only, like `auth::JwtCache` - losing a pending connect attempt
/// on restart just means the user clicks "Connect Git" again, not a
/// correctness problem.
#[derive(Default)]
pub struct GithubConnectState(Mutex<HashMap<String, PendingConnect>>);

impl GithubConnectState {
    /// Registers a pending claim and returns its `state` token. Also sweeps
    /// out anything already past `PENDING_TTL`, bounding memory to roughly
    /// "attempts started in the last ten minutes" rather than growing
    /// forever.
    pub fn start(&self, dashboard_principal: Principal, publisher: Principal, git_repo_url: String) -> String {
        let state_token = uuid::Uuid::new_v4().to_string();
        let mut pending = self.0.lock().unwrap();
        pending.retain(|_, p| p.created_at.elapsed() < PENDING_TTL);
        pending.insert(
            state_token.clone(),
            PendingConnect { dashboard_principal, publisher, git_repo_url, created_at: Instant::now() },
        );
        state_token
    }

    /// Consumes a pending claim - a `state` token is single-use whether it
    /// succeeds or fails, so a replayed GitHub redirect (or an attacker who
    /// somehow observes a `state` value) can't trigger a second
    /// registration from it.
    pub fn take(&self, state_token: &str) -> Option<(Principal, String)> {
        let mut pending = self.0.lock().unwrap();
        let entry = pending.remove(state_token)?;
        (entry.created_at.elapsed() < PENDING_TTL).then_some((entry.publisher, entry.git_repo_url))
    }
}

/// Extracts `(owner, repo)`, lowercased - mirrors
/// `backend::parse_github_owner_repo` exactly (duplicated rather than
/// shared across the crate boundary, same as `ic::types::MarketplaceItem`
/// already hand-mirrors `backend.did`). Must stay in sync with that
/// function: this module's whole job is deciding what gets passed to
/// `register_repo_publisher`, which re-derives and re-validates
/// `git_repo_url` itself regardless, so a mismatch here fails closed (the
/// canister call errors) rather than open.
fn parse_github_owner_repo(git_repo_url: &str) -> anyhow::Result<(String, String)> {
    let s = git_repo_url.trim();
    let s = s.strip_suffix(".git").unwrap_or(s);
    let path = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .ok_or_else(|| anyhow::anyhow!("git_repo_url must be a github.com repository URL"))?;
    let path = path.trim_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        anyhow::bail!("git_repo_url must look like https://github.com/{{owner}}/{{repo}}");
    }
    Ok((parts[0].to_lowercase(), parts[1].to_lowercase()))
}

/// The GitHub OAuth authorize URL to send the dashboard's popup to.
/// `public_repo` is the narrowest scope that lets `verify_repo_admin_access`
/// read a public repo's collaborator permissions - this flow has no reason
/// to ask for private-repo access, since every marketplace release is a
/// public GitHub Release asset anyway (see `validate_manifest_download_url`).
pub fn authorize_url(config: &Config, git_repo_url: &str, state_token: &str) -> anyhow::Result<String> {
    parse_github_owner_repo(git_repo_url)?; // fail fast on a malformed repo URL, before sending the user to GitHub at all
    let client_id = config
        .github_oauth_client_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("GITHUB_OAUTH_CLIENT_ID is not configured"))?;
    let base_url = config
        .public_base_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PUBLIC_BASE_URL is not configured"))?;

    let mut url = reqwest::Url::parse("https://github.com/login/oauth/authorize")?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("scope", "public_repo")
        .append_pair("state", state_token)
        .append_pair("redirect_uri", &format!("{base_url}/github/connect/callback"));
    Ok(url.to_string())
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Exchanges an OAuth `code` for a real access token - the one step in this
/// whole flow that requires the OAuth App's client secret, which is why it
/// can only happen here (server-side), never in the browser.
pub async fn exchange_code_for_token(config: &Config, code: &str) -> anyhow::Result<String> {
    let client_id = config
        .github_oauth_client_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("GITHUB_OAUTH_CLIENT_ID is not configured"))?;
    let client_secret = config
        .github_oauth_client_secret
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("GITHUB_OAUTH_CLIENT_SECRET is not configured"))?;
    let base_url = config
        .public_base_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PUBLIC_BASE_URL is not configured"))?;

    let response = reqwest::Client::new()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", &format!("{base_url}/github/connect/callback")),
        ])
        .send()
        .await?
        .error_for_status()?;
    let body: AccessTokenResponse = response.json().await?;
    body.access_token.ok_or_else(|| {
        anyhow::anyhow!(
            "GitHub token exchange failed: {}",
            body.error_description.or(body.error).unwrap_or_else(|| "unknown error".to_string())
        )
    })
}

#[derive(Deserialize)]
struct RepoPermissions {
    #[serde(default)]
    admin: bool,
}

#[derive(Deserialize)]
struct RepoResponse {
    permissions: Option<RepoPermissions>,
}

/// Confirms the GitHub account behind `access_token` has *admin* access to
/// `git_repo_url` - the same bar GitHub itself uses for "can manage this
/// repository's settings" (an org repo's non-admin collaborator, e.g., does
/// not qualify), which is the right proxy for "may claim this repo as a
/// marketplace publisher".
pub async fn verify_repo_admin_access(access_token: &str, git_repo_url: &str) -> anyhow::Result<bool> {
    let (owner, repo) = parse_github_owner_repo(git_repo_url)?;
    let response = reqwest::Client::new()
        .get(format!("https://api.github.com/repos/{owner}/{repo}"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "canister-hub-orchestrator")
        .send()
        .await?
        .error_for_status()?;
    let repo: RepoResponse = response.json().await?;
    Ok(repo.permissions.is_some_and(|p| p.admin))
}
