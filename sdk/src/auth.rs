use crate::transport::{encode, flatten, CanisterClient};
use crate::{Principal, Result};
use candid::CandidType;
#[cfg(feature = "client")]
use ic_agent::Agent;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const DEFAULT_PROFILE_CACHE_TTL_NS: u64 = 60_000_000_000;
const DEFAULT_AUTHORIZATION_CACHE_TTL_NS: u64 = 5_000_000_000;

#[derive(Clone)]
struct CachedProfile {
    value: Profile,
    cached_at_ns: u64,
}

#[derive(Clone)]
struct CachedAuthorization {
    value: Authorization,
    cached_at_ns: u64,
}

#[derive(Clone)]
struct CachedClaims {
    value: ProfileClaims,
    cached_at_ns: u64,
}

fn cache_now_ns() -> u64 {
    #[cfg(all(target_arch = "wasm32", feature = "browser"))]
    {
        return (js_sys::Date::now() * 1_000_000.0) as u64;
    }
    #[cfg(all(target_arch = "wasm32", feature = "ic", not(feature = "browser")))]
    {
        return ic_cdk::api::time();
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        return std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .min(u64::MAX as u128) as u64;
    }
    #[allow(unreachable_code)]
    0
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OAuthLink {
    pub provider: String,
    pub subject: String,
    pub email: Option<String>,
    pub linked_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Profile {
    pub id: u64,
    pub principal: Option<Principal>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub oauth_links: Vec<OAuthLink>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub profile_id: u64,
    pub principal: Option<Principal>,
}

/// Basic application-facing profile attributes. OAuth provider subjects and
/// linked-account details deliberately remain private to auth.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProfileClaims {
    pub profile_id: u64,
    pub principal: Option<Principal>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct UpdateProfile {
    pub display_name: Option<Option<String>>,
    pub avatar_url: Option<Option<String>>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct OAuthProviderConfig {
    pub client_id: String,
    pub client_secret: String,
    pub authorize_url: String,
    pub token_url: String,
    pub userinfo_url: String,
    pub redirect_uri: String,
    pub scope: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub providers: BTreeMap<String, OAuthProviderConfig>,
    pub session_ttl_secs: u64,
    pub frontend_redirect_url: Option<String>,
    pub trusted_canisters: Vec<Principal>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub session_ttl_secs: Option<u64>,
    pub frontend_redirect_url: Option<Option<String>>,
    pub trusted_canisters: Option<Vec<Principal>>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
    pub upgrade: Option<bool>,
    pub status_code: u16,
}

#[derive(Clone)]
pub struct AuthClient(
    CanisterClient,
    Arc<Mutex<BTreeMap<u64, CachedProfile>>>,
    u64,
    Arc<Mutex<BTreeMap<Principal, CachedAuthorization>>>,
    u64,
    Arc<Mutex<BTreeMap<Principal, CachedClaims>>>,
);

impl AuthClient {
    fn with_transport(transport: CanisterClient) -> Self {
        Self(
            transport,
            Arc::new(Mutex::new(BTreeMap::new())),
            DEFAULT_PROFILE_CACHE_TTL_NS,
            Arc::new(Mutex::new(BTreeMap::new())),
            DEFAULT_AUTHORIZATION_CACHE_TTL_NS,
            Arc::new(Mutex::new(BTreeMap::new())),
        )
    }

    #[cfg(feature = "client")]
    pub fn new(agent: Arc<Agent>, canister_id: Principal) -> Self {
        Self::with_transport(CanisterClient::new(agent, canister_id))
    }

    #[cfg(feature = "client")]
    pub fn from_text(agent: Arc<Agent>, canister_id: &str) -> Result<Self> {
        Ok(Self::with_transport(CanisterClient::from_text(
            agent,
            canister_id,
        )?))
    }

    /// Creates a client for bounded calls made from a Rust canister.
    #[cfg(feature = "ic")]
    pub fn for_canister(canister_id: Principal) -> Self {
        Self::with_transport(CanisterClient::for_canister(canister_id))
    }

    /// Changes how long fetched profiles remain in this client's shared
    /// cache. Clones created from this value inherit the duration.
    pub fn with_profile_cache_ttl_ns(mut self, ttl_ns: u64) -> Self {
        self.2 = ttl_ns;
        self
    }

    pub fn clear_profile_cache(&self) {
        self.1
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Changes the short cache window used by `authorize_principal`.
    /// Keep this small: access revocation takes effect after this window.
    pub fn with_authorization_cache_ttl_ns(mut self, ttl_ns: u64) -> Self {
        self.4 = ttl_ns;
        self
    }

    pub fn clear_authorization_cache(&self) {
        self.3
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    fn cached_authorization(&self, principal: &Principal) -> Option<Authorization> {
        let now = cache_now_ns();
        let mut cache = self
            .3
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.get(principal)?;
        if now.saturating_sub(cached.cached_at_ns) <= self.4 {
            return Some(cached.value.clone());
        }
        cache.remove(principal);
        None
    }

    fn cache_authorization(&self, principal: Principal, authorization: &Authorization) {
        self.3
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                principal,
                CachedAuthorization {
                    value: authorization.clone(),
                    cached_at_ns: cache_now_ns(),
                },
            );
    }

    fn cached_claims(&self, principal: &Principal) -> Option<ProfileClaims> {
        let now = cache_now_ns();
        let mut cache = self
            .5
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.get(principal)?;
        if now.saturating_sub(cached.cached_at_ns) <= self.2 {
            return Some(cached.value.clone());
        }
        cache.remove(principal);
        None
    }

    fn cache_claims(&self, principal: Principal, claims: &ProfileClaims) {
        self.5
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                principal,
                CachedClaims {
                    value: claims.clone(),
                    cached_at_ns: cache_now_ns(),
                },
            );
    }

    pub fn clear_claims_cache(&self) {
        self.5
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    fn cached_profile(&self, id: u64) -> Option<Profile> {
        let now = cache_now_ns();
        let mut cache = self
            .1
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.get(&id)?;
        if now.saturating_sub(cached.cached_at_ns) <= self.2 {
            return Some(cached.value.clone());
        }
        cache.remove(&id);
        None
    }

    fn cache_profile(&self, profile: &Profile) {
        self.1
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                profile.id,
                CachedProfile {
                    value: profile.clone(),
                    cached_at_ns: cache_now_ns(),
                },
            );
    }

    pub fn canister_id(&self) -> Principal {
        self.0.canister_id()
    }

    pub async fn begin_oauth(&self, provider: impl Into<String>, link: bool) -> Result<String> {
        const METHOD: &str = "begin_oauth";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (provider.into(), link))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn authorize_principal(&self, principal: Principal) -> Result<Option<Authorization>> {
        const METHOD: &str = "authorize_principal";
        if let Some(authorization) = self.cached_authorization(&principal) {
            return Ok(Some(authorization));
        }
        let authorization = self.0.query(METHOD, encode(METHOD, (principal,))?).await?;
        if let Some(value) = &authorization {
            self.cache_authorization(principal, value);
        }
        Ok(authorization)
    }

    pub async fn authorize_session(
        &self,
        session_token: impl Into<String>,
    ) -> Result<Option<Authorization>> {
        const METHOD: &str = "authorize_session";
        self.0
            .query(METHOD, encode(METHOD, (session_token.into(),))?)
            .await
    }

    /// Resolves basic claims for a principal. The auth canister accepts this
    /// only from controllers or configured trusted application canisters.
    pub async fn resolve_principal(&self, principal: Principal) -> Result<Option<ProfileClaims>> {
        const METHOD: &str = "resolve_principal";
        if let Some(claims) = self.cached_claims(&principal) {
            return Ok(Some(claims));
        }
        let result = self.0.query(METHOD, encode(METHOD, (principal,))?).await?;
        let claims = flatten(METHOD, result)?;
        if let Some(value) = &claims {
            self.cache_claims(principal, value);
        }
        Ok(claims)
    }

    /// Resolves the basic claims belonging to a valid OAuth bearer session.
    /// Session results are intentionally not inserted into the principal
    /// cache because the bearer token is the authority for this lookup.
    pub async fn resolve_session(
        &self,
        session_token: impl Into<String>,
    ) -> Result<Option<ProfileClaims>> {
        const METHOD: &str = "resolve_session";
        self.0
            .query(METHOD, encode(METHOD, (session_token.into(),))?)
            .await
    }

    pub async fn get_my_profile(&self) -> Result<Option<Profile>> {
        const METHOD: &str = "get_my_profile";
        let result = self.0.query(METHOD, encode(METHOD, ())?).await?;
        let profile = flatten(METHOD, result)?;
        if let Some(value) = &profile {
            self.cache_profile(value);
        }
        Ok(profile)
    }

    pub async fn update_my_profile(&self, update: UpdateProfile) -> Result<Profile> {
        const METHOD: &str = "update_my_profile";
        let result = self.0.update(METHOD, encode(METHOD, (update,))?).await?;
        let profile = flatten(METHOD, result)?;
        self.cache_profile(&profile);
        Ok(profile)
    }

    pub async fn link_current_principal(
        &self,
        session_token: impl Into<String>,
    ) -> Result<Profile> {
        const METHOD: &str = "link_current_principal";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (session_token.into(),))?)
            .await?;
        let profile = flatten(METHOD, result)?;
        self.cache_profile(&profile);
        Ok(profile)
    }

    pub async fn get_profile_by_session(
        &self,
        session_token: impl Into<String>,
    ) -> Result<Option<Profile>> {
        const METHOD: &str = "get_profile_by_session";
        let profile = self
            .0
            .query(METHOD, encode(METHOD, (session_token.into(),))?)
            .await?;
        // Do not seed the id-only cache from a bearer-token lookup: doing so
        // would let a later id-only call reuse private profile data without
        // presenting that token again.
        Ok(profile)
    }

    pub async fn get_profile(&self, id: u64) -> Result<Option<Profile>> {
        const METHOD: &str = "get_profile";
        if let Some(profile) = self.cached_profile(id) {
            return Ok(Some(profile));
        }
        let result = self.0.query(METHOD, encode(METHOD, (id,))?).await?;
        let profile = flatten(METHOD, result)?;
        if let Some(value) = &profile {
            self.cache_profile(value);
        }
        Ok(profile)
    }

    pub async fn list_profiles(&self, offset: u64, limit: u64) -> Result<Vec<Profile>> {
        const METHOD: &str = "list_profiles";
        let result = self
            .0
            .query(METHOD, encode(METHOD, (offset, limit))?)
            .await?;
        let profiles = flatten(METHOD, result)?;
        for profile in &profiles {
            self.cache_profile(profile);
        }
        Ok(profiles)
    }

    pub async fn get_config(&self) -> Result<Config> {
        const METHOD: &str = "get_auth_config";
        let result = self.0.query(METHOD, encode(METHOD, ())?).await?;
        flatten(METHOD, result)
    }

    pub async fn set_oauth_provider(
        &self,
        name: impl Into<String>,
        config: OAuthProviderConfig,
    ) -> Result<()> {
        const METHOD: &str = "set_oauth_provider";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (name.into(), config))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn remove_oauth_provider(&self, name: impl Into<String>) -> Result<()> {
        const METHOD: &str = "remove_oauth_provider";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (name.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn update_config(&self, update: ConfigUpdate) -> Result<()> {
        const METHOD: &str = "update_config";
        let result = self.0.update(METHOD, encode(METHOD, (update,))?).await?;
        flatten(METHOD, result)
    }

    pub async fn http_request(&self, request: HttpRequest) -> Result<HttpResponse> {
        const METHOD: &str = "http_request";
        self.0.query(METHOD, encode(METHOD, (request,))?).await
    }

    pub async fn http_request_update(&self, request: HttpRequest) -> Result<HttpResponse> {
        const METHOD: &str = "http_request_update";
        self.0.update(METHOD, encode(METHOD, (request,))?).await
    }

    pub async fn llm_context(&self) -> Result<String> {
        const METHOD: &str = "llm_context";
        self.0.query(METHOD, encode(METHOD, ())?).await
    }
}
