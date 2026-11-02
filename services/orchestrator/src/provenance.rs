//! GitHub Artifact Attestation (build provenance) verification.
//!
//! This answers a different question than `src/github.rs`'s "Connect Git"
//! flow does. That flow proves *who* may claim a repository (its verified
//! GitHub-admin owner). This module proves something stronger about one
//! specific Wasm artifact: that it was actually *produced* by that
//! repository's own CI, not merely uploaded by someone who happens to
//! administer it (a legitimate, Connect-Git-verified owner could still
//! publish a locally-modified binary with nothing today catching that).
//!
//! Uses GitHub's "Artifact Attestations" feature
//! (`actions/attest-build-provenance`), which is Sigstore-backed: a
//! workflow run in a specific repo gets a short-lived signing certificate
//! from Sigstore's Fulcio CA, issued via GitHub's own OIDC token and
//! embedding that exact repo/workflow identity as X.509 extensions, and
//! uses it to sign an in-toto attestation over the artifact's digest.
//! Verifying the attestation means verifying that certificate chains to
//! Sigstore's real trust root, was issued by GitHub Actions' real OIDC
//! issuer, names this exact repository, and signs exactly this digest.
//!
//! Known limitation, upstream in the `sigstore` crate (0.14.0), not
//! something this module works around: full Rekor transparency-log
//! inclusion-proof and Signed-Entry-Timestamp verification aren't
//! implemented yet (see `sigstore-rs#285`) - what's verified here is still
//! the certificate chain, the OIDC issuer, the repository identity, and the
//! signature-over-digest, which already rules out anything not freshly
//! signed by a real GitHub Actions run in the claimed repo.

use crate::config::Config;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sigstore::bundle::verify::policy::{
    GitHubWorkflowRepository, OIDCIssuer, PolicyResult, SingleX509ExtPolicy, VerificationPolicy,
};
use sigstore::bundle::verify::Verifier;
use sigstore::bundle::Bundle;
use std::sync::Arc;
use tokio::sync::OnceCell;

const GITHUB_ACTIONS_OIDC_ISSUER: &str = "https://token.actions.githubusercontent.com";

/// Both checks ANDed together, as one concrete, `Send`-able type - the
/// library's own `AllOf` combinator type-erases to `Vec<&dyn
/// VerificationPolicy>`, which isn't `Send` and so can't be held across the
/// `.await` inside `Verifier::verify_digest` from a context (the
/// tool-calling agent loop) that needs its futures to stay `Send`.
struct RepoAttestationPolicy {
    issuer: OIDCIssuer,
    repository: GitHubWorkflowRepository,
}

impl VerificationPolicy for RepoAttestationPolicy {
    fn verify(&self, cert: &x509_cert::Certificate) -> PolicyResult {
        self.issuer.verify(cert)?;
        self.repository.verify(cert)
    }
}

/// Built once per process against Sigstore's real public-good trust root
/// (a TUF fetch) and reused for every verification - this is the same
/// trust root for every call, regardless of which repo/artifact is being
/// checked, so there's no reason to pay that fetch cost per install.
static VERIFIER: OnceCell<Arc<Verifier>> = OnceCell::const_new();

async fn verifier() -> anyhow::Result<Arc<Verifier>> {
    VERIFIER
        .get_or_try_init(|| async {
            Verifier::production()
                .await
                .map(Arc::new)
                .map_err(|e| anyhow::anyhow!("failed to initialize Sigstore verifier against the public-good trust root: {e}"))
        })
        .await
        .cloned()
}

/// Mirrors `backend::parse_github_owner_repo` - see `github.rs`'s identical
/// helper for why this is duplicated rather than shared.
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

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct AttestationsResponse {
    #[serde(default)]
    attestations: Vec<Attestation>,
}

#[derive(Deserialize)]
struct Attestation {
    bundle: Bundle,
}

async fn fetch_attestations(
    config: &Config,
    owner: &str,
    repo: &str,
    digest_hex: &str,
) -> anyhow::Result<Vec<Bundle>> {
    let mut request = reqwest::Client::new()
        .get(format!(
            "https://api.github.com/repos/{owner}/{repo}/attestations/sha256:{digest_hex}"
        ))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "canister-hub-orchestrator");
    if let Some(token) = config.github_api_token.as_deref() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request.send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    let body: AttestationsResponse = response.error_for_status()?.json().await?;
    Ok(body.attestations.into_iter().map(|a| a.bundle).collect())
}

/// Verifies that at least one GitHub build-provenance attestation exists
/// for `wasm_bytes` and was genuinely signed by a GitHub Actions run in
/// `git_repo_url` - fails closed (an error) if none is found or none
/// verifies, same posture as `wasm_hash` checking.
pub async fn verify_build_provenance(
    config: &Config,
    git_repo_url: &str,
    wasm_bytes: &[u8],
) -> anyhow::Result<()> {
    let (owner, repo) = parse_github_owner_repo(git_repo_url)?;
    let digest_hex = to_hex(&Sha256::digest(wasm_bytes));

    let bundles = fetch_attestations(config, &owner, &repo, &digest_hex).await?;
    if bundles.is_empty() {
        anyhow::bail!(
            "no GitHub build provenance attestation found for this release artifact - the publisher's CI must run \
             actions/attest-build-provenance on it (see publish_to_market/action.yml)"
        );
    }

    let verifier = verifier().await?;
    let repository_identity = format!("https://github.com/{owner}/{repo}");
    let policy = RepoAttestationPolicy {
        issuer: OIDCIssuer::new(GITHUB_ACTIONS_OIDC_ISSUER),
        repository: GitHubWorkflowRepository::new(&repository_identity),
    };

    let mut last_error = None;
    for bundle in bundles {
        let mut hasher = Sha256::new();
        hasher.update(wasm_bytes);
        // `offline: true` - this crate doesn't yet verify Rekor inclusion
        // proofs either way (see this module's doc comment), so there's
        // nothing extra an online call to Rekor would currently buy here.
        match verifier.verify_digest(hasher, bundle, &policy, true).await {
            Ok(()) => return Ok(()),
            Err(e) => last_error = Some(e),
        }
    }
    Err(anyhow::anyhow!(
        "found attestation(s) for this artifact, but none verified as a genuine GitHub Actions build in {git_repo_url}: {}",
        last_error.map(|e| e.to_string()).unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The live GitHub API / Sigstore trust-root-fetch path (`verify_build_provenance`
    // itself) needs real network access and a real attested artifact to
    // exercise meaningfully - not something to fake convincingly in a unit
    // test (same call as `github.rs`'s OAuth exchange - see that module's
    // own route tests for the same tradeoff). What's covered here is the
    // pure logic: repo URL parsing and digest formatting, since both feed
    // directly into the GitHub API URL and the policy check.

    #[test]
    fn parses_owner_and_repo_lowercased() {
        let (owner, repo) =
            parse_github_owner_repo("https://github.com/Alice/Cool-Project").unwrap();
        assert_eq!(owner, "alice");
        assert_eq!(repo, "cool-project");
    }

    #[test]
    fn parses_a_dot_git_suffixed_url() {
        let (owner, repo) =
            parse_github_owner_repo("https://github.com/alice/cool-project.git").unwrap();
        assert_eq!(owner, "alice");
        assert_eq!(repo, "cool-project");
    }

    #[test]
    fn rejects_a_non_github_url() {
        assert!(parse_github_owner_repo("https://gitlab.com/alice/cool-project").is_err());
    }

    #[test]
    fn rejects_extra_path_segments() {
        assert!(parse_github_owner_repo("https://github.com/alice/cool-project/releases").is_err());
    }

    #[test]
    fn to_hex_matches_a_known_sha256_digest() {
        // sha256("") - a standard test vector, not computed by the code under test.
        let empty_digest = Sha256::digest([]);
        assert_eq!(
            to_hex(&empty_digest),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
