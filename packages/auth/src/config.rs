//! Runtime configuration: OAuth provider credentials/endpoints (`OAuthProviderConfig`,
//! keyed by provider name in `Config::providers`), session/frontend settings,
//! and the application-canister allowlist. Fixed scalar settings use the
//! dynamic config surface; the complete administrative view is returned by
//! `get_auth_config`.
//!
//! Providers get their own `set_oauth_provider`/`remove_oauth_provider`
//! update methods rather than folding into a `ConfigUpdate` (unlike
//! `connector`'s single-struct convention) - a provider is itself a small
//! record, and "replace provider X's whole config" or "remove provider X"
//! are the only operations that make sense on a collection, unlike
//! `ConfigUpdate`'s per-field patch scheme.

use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Fixed-shape settings exposed to the marketplace's generic configuration
/// form. Provider records and the trusted-canister allowlist remain on their
/// dedicated APIs because both are variable-length collections.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, DynamicConfig)]
pub struct RuntimeConfig {
    #[config(
        label = "Session TTL (seconds)",
        description = "How long an OAuth session remains valid",
        default = 86400
    )]
    pub session_ttl_secs: i64,
    #[config(
        label = "Frontend Redirect URL",
        description = "URL receiving the session token after a successful OAuth login"
    )]
    pub frontend_redirect_url: Option<String>,
}

/// Everything needed to run the OAuth 2.0 Authorization Code flow against
/// one provider (Google, GitHub, or any other OAuth2-compliant service) -
/// see `oauth.rs` for how each field is used. Deliberately provider-agnostic:
/// nothing here is Google- or GitHub-specific, the same as `agent`'s
/// `llm_provider` isn't tied to one LLM vendor.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct OAuthProviderConfig {
    pub client_id: String,
    /// Kept in canister state the same way `connector`'s channel secrets
    /// are (see that crate's `Config` doc comment) - controller-gated
    /// `get_auth_config` is this template's access-control boundary for it, not
    /// on-chain secret management (vetKD) - a real deployment with a
    /// stricter threat model should consider that instead.
    pub client_secret: String,
    pub authorize_url: String,
    pub token_url: String,
    pub userinfo_url: String,
    /// Must exactly match what's registered with the provider - typically
    /// `https://<canister-id>.icp0.io/oauth/<provider-name>/callback` (or
    /// the `*.raw.icp0.io` form if the provider's own redirect validation
    /// rejects `icp0.io`'s HTML-certification wrapper - see README.md).
    pub redirect_uri: String,
    pub scope: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    /// Provider name (caller's own choice, e.g. "google", "github") ->
    /// its settings. Candid has no map type of its own; candid's derive
    /// renders a `BTreeMap` as `vec record { text; OAuthProviderConfig }`,
    /// the same shape a hand-written `vec record {...}` field would have.
    pub providers: BTreeMap<String, OAuthProviderConfig>,
    /// How long a session issued by a completed OAuth login stays valid -
    /// see `state.rs::SessionRecord`.
    pub session_ttl_secs: u64,
    /// Where a completed login redirects the browser back to, with
    /// `?session=<token>` appended (e.g. `https://myapp.example.com/auth/callback`).
    /// `None` means `http_request_update`'s OAuth callback renders the
    /// token directly as a plain-text page instead of redirecting -
    /// functional for testing, not what a real frontend integration wants.
    pub frontend_redirect_url: Option<String>,
    /// Application canisters allowed to resolve profile claims by principal.
    /// Defaulting preserves CBOR compatibility with configurations written
    /// before this field existed.
    #[serde(default)]
    pub trusted_canisters: Vec<Principal>,
}

/// `update_config`'s argument. Providers remain managed separately. An outer
/// `None` leaves a field untouched; the nested option for the redirect URL
/// distinguishes clearing it from setting it. `Some(trusted_canisters)`
/// replaces the complete allowlist.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub session_ttl_secs: Option<u64>,
    pub frontend_redirect_url: Option<Option<String>>,
    /// `None` leaves the allowlist unchanged; `Some` replaces it completely.
    pub trusted_canisters: Option<Vec<Principal>>,
}

impl Config {
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.session_ttl_secs {
            self.session_ttl_secs = v;
        }
        if let Some(v) = update.frontend_redirect_url {
            self.frontend_redirect_url = v;
        }
        if let Some(v) = update.trusted_canisters {
            self.trusted_canisters = v;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(client_id: &str) -> OAuthProviderConfig {
        OAuthProviderConfig {
            client_id: client_id.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn default_update_changes_nothing() {
        let config = Config {
            providers: BTreeMap::from([("google".to_string(), provider("abc"))]),
            session_ttl_secs: 3600,
            frontend_redirect_url: Some("https://example.com".to_string()),
            trusted_canisters: vec![],
        };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn some_none_clears_a_field_without_touching_others() {
        let config = Config {
            session_ttl_secs: 3600,
            frontend_redirect_url: Some("https://example.com".to_string()),
            ..Default::default()
        };
        let updated = config.apply(ConfigUpdate {
            frontend_redirect_url: Some(None),
            ..Default::default()
        });
        assert_eq!(updated.frontend_redirect_url, None);
        assert_eq!(
            updated.session_ttl_secs, 3600,
            "unrelated fields must be untouched"
        );
    }

    #[test]
    fn some_some_sets_a_field_without_touching_others() {
        let config = Config {
            session_ttl_secs: 3600,
            ..Default::default()
        };
        let updated = config.apply(ConfigUpdate {
            session_ttl_secs: Some(7200),
            ..Default::default()
        });
        assert_eq!(updated.session_ttl_secs, 7200);
    }

    #[test]
    fn trusted_canister_update_replaces_only_the_allowlist() {
        let trusted = Principal::from_slice(&[7; 10]);
        let config = Config {
            session_ttl_secs: 3600,
            ..Default::default()
        };
        let updated = config.apply(ConfigUpdate {
            trusted_canisters: Some(vec![trusted]),
            ..Default::default()
        });
        assert_eq!(updated.trusted_canisters, vec![trusted]);
        assert_eq!(updated.session_ttl_secs, 3600);
    }
}
