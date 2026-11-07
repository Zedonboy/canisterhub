//! `auth`: user/profile management and authentication for the other
//! building blocks in this project - "this canister is in charge of
//! user/profile management and authentication, handle OAuth etc" (the
//! user's own framing).
//!
//! ## Two ways to be "signed in"
//!
//! The IC already has a real, free, non-custodial identity system
//! (Internet Identity and anything else that hands a canister a real
//! caller `Principal`) - a canister doesn't need to reinvent that. But a
//! lot of real products also want "Sign in with Google" (or GitHub, or any
//! other OAuth2 provider) for users who don't have an IC identity yet, or
//! who expect that specific button. This canister supports both, and lets
//! one `Profile` be reachable either way:
//!
//! 1. **Principal-native**: `get_my_profile`/`update_my_profile` use the
//!    caller's own `msg_caller()` directly - no separate "login" step,
//!    exactly the usual IC pattern. First call for a given principal
//!    creates its `Profile`.
//! 2. **OAuth**: `begin_oauth(provider)` returns a URL to send the
//!    browser to; the provider's own redirect back to this canister's
//!    `/oauth/<provider>/callback` HTTP endpoint (`http_request_update`,
//!    see `handle_oauth_callback`) exchanges the authorization code for
//!    the user's real identity at that provider (`oauth::exchange_code`),
//!    finds or creates the matching `Profile`, and issues a session token,
//!    read back via `get_profile_by_session` the same way a traditional
//!    web app's session cookie would be.
//!
//! `link_current_principal` connects the two: an already-authenticated
//! (principal) caller who also holds a valid session token from an OAuth
//! login can attach that OAuth identity to their existing principal-based
//! profile, so one real person's `Profile` doesn't fork into two.
//!
//! ## Security model
//!
//! - Every principal-scoped method (`get_my_profile`, `update_my_profile`,
//!   `link_current_principal`) rejects the anonymous principal outright -
//!   see `require_authenticated` and the `canister-security` skill's own
//!   guidance on why every such check must be duplicated in the method
//!   itself, not left to `canister_inspect_message` alone.
//! - `begin_oauth`'s CSRF `state` token is single-use (see
//!   `state::take_pending_state`) and is what actually selects which
//!   provider's config the callback trusts - never the URL path segment
//!   alone (see `handle_oauth_callback`'s own comment on why).
//! - `client_secret` lives in `Config` the same way `connector`'s channel
//!   secrets do (see its own doc comment) - controller-gated `get_config`
//!   is this template's access-control boundary for it, not on-chain
//!   secret management (vetKD); a deployment with a stricter threat model
//!   should consider that instead.
//! - `resolve_principal` exposes basic profile claims only to controllers and
//!   canisters in `Config::trusted_canisters`. `resolve_session` requires the
//!   corresponding bearer token, so possession of the session is its access
//!   boundary.
//! - `list_profiles`/`get_profile`/`update_config`/`get_config`/
//!   `set_oauth_provider`/`remove_oauth_provider` are all controller-only -
//!   profile data (emails, linked accounts) and provider credentials alike
//!   aren't readable or changeable by an arbitrary caller.

mod config;
mod http;
mod messages;
mod oauth;
mod state;

pub use config::{Config, ConfigUpdate, OAuthProviderConfig, RuntimeConfig};
pub use http::{HttpRequest, HttpResponse};
pub use messages::{Authorization, OAuthLink, Profile, ProfileClaims, UpdateProfile};

use candid::Principal;

canister_hub_sdk::ic::metadata::canister_metadata!(
    name = "auth",
    description = "User/profile management and authentication - Internet Identity-native profiles plus OAuth2 sign-in, session tokens, and cross-canister profile resolution.",
    canister_type = "auth",
    // Matches `canister.yaml`'s own `crate:version` metadata - keep both
    // in sync by hand when bumping either.
    version = "1.0.0",
);

/// How long a `state` token from `begin_oauth` stays valid, waiting for the
/// provider's own redirect back - generous enough for a real human to
/// actually go through a consent screen, short enough that an abandoned
/// flow doesn't linger indefinitely.
const PENDING_STATE_TTL_SECS: u64 = 600;

fn require_authenticated(caller: Principal) -> Result<Principal, String> {
    if caller == Principal::anonymous() {
        return Err("anonymous caller not allowed".to_string());
    }
    Ok(caller)
}

fn require_controller() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err("only a controller may call this method".to_string())
    }
}

fn may_resolve_principal_claims(
    caller: &Principal,
    caller_is_controller: bool,
    trusted_canisters: &[Principal],
) -> bool {
    caller_is_controller || trusted_canisters.contains(caller)
}

fn require_trusted_canister() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if may_resolve_principal_claims(
        &caller,
        ic_cdk::api::is_controller(&caller),
        &state::get_config().trusted_canisters,
    ) {
        Ok(())
    } else {
        Err("only a controller or trusted application canister may resolve profile claims by principal".to_string())
    }
}

fn runtime_session_ttl_secs() -> Result<u64, String> {
    let value = canister_hub_sdk::ic::config::get_env_number("session_ttl_secs")
        .ok_or_else(|| "session_ttl_secs is not configured".to_string())?;
    u64::try_from(value).map_err(|_| "session_ttl_secs must not be negative".to_string())
}

fn runtime_frontend_redirect_url() -> Option<String> {
    canister_hub_sdk::ic::config::get_env_text("frontend_redirect_url")
}

#[ic_cdk::init]
fn init(_project_context: canister_hub_sdk::ProjectContext) {
    state::init_dynamic_config_store();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    state::init_dynamic_config_store();
}

// ---------------------------------------------------------------------------
// Principal-native path
// ---------------------------------------------------------------------------

/// This caller's own profile - `None` if it has never called
/// `update_my_profile` (there's nothing to auto-create on a read-only
/// call). Rejects the anonymous principal, same as every other
/// caller-scoped method here.
#[ic_cdk::query]
fn get_my_profile() -> Result<Option<Profile>, String> {
    let caller = require_authenticated(ic_cdk::api::msg_caller())?;
    Ok(state::get_profile_by_principal(&caller))
}

/// Creates this caller's profile on first call, or applies `update` to the
/// existing one - see `UpdateProfile`'s own doc comment for why `email`
/// isn't one of the fields it can set (that only ever comes from a
/// verified OAuth provider, via `link_current_principal`/a fresh OAuth
/// sign-in).
#[ic_cdk::update]
fn update_my_profile(update: UpdateProfile) -> Result<Profile, String> {
    let caller = require_authenticated(ic_cdk::api::msg_caller())?;
    let now = ic_cdk::api::time();

    let mut profile = state::get_profile_by_principal(&caller).unwrap_or_else(|| Profile {
        id: state::new_profile_id(),
        principal: Some(caller),
        display_name: None,
        email: None,
        avatar_url: None,
        oauth_links: vec![],
        created_at: now,
        updated_at: now,
    });

    if let Some(v) = update.display_name {
        profile.display_name = v;
    }
    if let Some(v) = update.avatar_url {
        profile.avatar_url = v;
    }
    profile.updated_at = now;

    state::insert_profile(profile.clone());
    Ok(profile)
}

/// Attaches the OAuth identity behind `session_token` (from a completed
/// `begin_oauth`/callback flow) to this caller's own principal-based
/// profile - the two-paths-become-one operation described in this crate's
/// module doc comment. Fails if `session_token` is invalid/expired, if
/// that OAuth identity is already linked to a *different* profile, or if
/// this caller's principal is already linked to a *different* profile than
/// the session's own (each profile has at most one principal).
#[ic_cdk::update]
fn link_current_principal(session_token: String) -> Result<Profile, String> {
    let caller = require_authenticated(ic_cdk::api::msg_caller())?;
    let now = ic_cdk::api::time();

    let session =
        state::get_session(&session_token, now).ok_or("session token is invalid or has expired")?;
    let mut oauth_profile = state::get_profile(session.profile_id)
        .ok_or("session refers to a profile that no longer exists")?;

    if let Some(existing) = oauth_profile.principal {
        if existing != caller {
            return Err(
                "this OAuth identity is already linked to a different principal".to_string(),
            );
        }
        return Ok(oauth_profile); // Already linked to this exact caller - idempotent.
    }
    if let Some(existing_profile) = state::get_profile_by_principal(&caller) {
        if existing_profile.id != oauth_profile.id {
            return Err("this principal is already linked to a different profile".to_string());
        }
    }

    oauth_profile.principal = Some(caller);
    oauth_profile.updated_at = now;
    state::insert_profile(oauth_profile.clone());
    Ok(oauth_profile)
}

// ---------------------------------------------------------------------------
// OAuth path
// ---------------------------------------------------------------------------

/// Starts an OAuth login (or, if `link` is set, a request to link a new
/// provider onto the *caller's own already-authenticated* principal
/// profile) against `provider` - returns the URL to send the browser to.
/// An `#[update]`, not `#[query]`: generating a real CSRF `state` token
/// needs real randomness (`raw_rand`, itself an inter-canister call to the
/// management canister, which only an update call can make).
#[ic_cdk::update]
async fn begin_oauth(provider: String, link: bool) -> Result<String, String> {
    let linking_principal = if link {
        Some(require_authenticated(ic_cdk::api::msg_caller())?)
    } else {
        None
    };

    let config = state::get_config();
    let provider_config = config
        .providers
        .get(&provider)
        .ok_or_else(|| format!("no OAuth provider named '{provider}' is configured"))?;

    let token = random_token().await?;
    state::insert_pending_state(
        token.clone(),
        state::PendingOAuthState {
            provider: provider.clone(),
            linking_principal,
            created_at: ic_cdk::api::time(),
        },
    );

    Ok(oauth::authorize_url(provider_config, &token))
}

/// A profile reached via a session token from a completed OAuth login -
/// the counterpart to `get_my_profile`'s principal-based lookup, for a
/// caller that only has a session token (a plain browser session, no IC
/// identity of its own). `None` for an invalid or expired token - see
/// `state::get_session`'s own doc comment on why the two aren't
/// distinguished.
#[ic_cdk::query]
fn get_profile_by_session(session_token: String) -> Option<Profile> {
    let session = state::get_session(&session_token, ic_cdk::api::time())?;
    state::get_profile(session.profile_id)
}

/// Minimal, non-sensitive identity lookup for application canisters.
#[ic_cdk::query]
fn authorize_principal(principal: Principal) -> Option<Authorization> {
    if principal == Principal::anonymous() {
        return None;
    }
    state::get_profile_by_principal(&principal).map(|profile| Authorization {
        profile_id: profile.id,
        principal: profile.principal,
    })
}

/// Session-token counterpart used by HTTP API canisters, whose gateway
/// requests do not carry the end user's IC caller principal.
#[ic_cdk::query]
fn authorize_session(session_token: String) -> Option<Authorization> {
    let session = state::get_session(&session_token, ic_cdk::api::time())?;
    let profile = state::get_profile(session.profile_id)?;
    Some(Authorization {
        profile_id: profile.id,
        principal: profile.principal,
    })
}

/// Returns basic profile attributes for a principal. Unlike
/// `authorize_principal`, this exposes personal data and is therefore limited
/// to controllers and explicitly trusted application canisters.
#[ic_cdk::query]
fn resolve_principal(principal: Principal) -> Result<Option<ProfileClaims>, String> {
    require_trusted_canister()?;
    if principal == Principal::anonymous() {
        return Ok(None);
    }
    Ok(state::get_profile_by_principal(&principal)
        .as_ref()
        .map(ProfileClaims::from))
}

/// Bearer-token counterpart. Possession of a valid unexpired session is the
/// authority to read that session's own basic profile attributes.
#[ic_cdk::query]
fn resolve_session(session_token: String) -> Option<ProfileClaims> {
    let session = state::get_session(&session_token, ic_cdk::api::time())?;
    state::get_profile(session.profile_id)
        .as_ref()
        .map(ProfileClaims::from)
}

// ---------------------------------------------------------------------------
// HTTP (OAuth callback only)
// ---------------------------------------------------------------------------

const OAUTH_PATH_PREFIX: &str = "/oauth/";
const OAUTH_PATH_SUFFIX: &str = "/callback";

/// Recognizes `/oauth/<provider>/callback` (any `<provider>` - validated
/// for real once the `state` token is checked, see `handle_oauth_callback`)
/// and upgrades it to the update call, since handling it always mutates
/// state (issues a session, creates/updates a profile) - see `http.rs`'s
/// doc comment for why every such request must go through
/// `http_request_update`, never be handled directly in this query call.
#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    if req.method == "GET"
        && path.starts_with(OAUTH_PATH_PREFIX)
        && path.ends_with(OAUTH_PATH_SUFFIX)
    {
        HttpResponse::upgrade_to_update()
    } else {
        HttpResponse::not_found()
    }
}

#[ic_cdk::update]
async fn http_request_update(req: HttpRequest) -> HttpResponse {
    let (path, query) = http::path_and_query(&req.url);
    let Some(provider_from_path) = path
        .strip_prefix(OAUTH_PATH_PREFIX)
        .and_then(|rest| rest.strip_suffix(OAUTH_PATH_SUFFIX))
    else {
        return HttpResponse::not_found();
    };
    let code = http::query_param(query, "code");
    let oauth_state = http::query_param(query, "state");
    let (Some(code), Some(oauth_state)) = (code, oauth_state) else {
        return HttpResponse::text(400, "missing code or state parameter");
    };

    handle_oauth_callback(provider_from_path, &code, &oauth_state).await
}

/// Does the real work behind an OAuth redirect landing back on this
/// canister: validates the CSRF `state` (single-use - see
/// `state::take_pending_state`), exchanges `code` for the user's real
/// identity at the provider, finds or creates the matching `Profile`, and
/// issues a session.
///
/// `oauth_state`'s own stored `provider` - never `provider_from_path` - is
/// what selects the provider config to use for the exchange: a URL path
/// segment is just routing, not something a valid `state` token has
/// already vouched for, so trusting it directly would let a `state` token
/// issued for one provider be replayed against a different provider's
/// endpoint path. They're required to match below regardless, but the
/// config lookup itself uses the value that's actually been validated.
///
/// Known limitation, not addressed here: two concurrent callbacks for the
/// same real external user (e.g. two browser tabs completing two separate
/// `begin_oauth` flows for the same provider account at nearly the same
/// moment) could each find no existing profile yet and each create one,
/// producing two profiles for one real person. Each individual `state`
/// token is single-use (preventing a *replay* of one callback), but that
/// doesn't serialize two genuinely different, both-legitimate flows
/// against each other - closing that fully needs a lock keyed by the
/// provider/subject pair, which isn't known until after the very outcall
/// this lock would need to guard.
async fn handle_oauth_callback(
    provider_from_path: &str,
    code: &str,
    oauth_state: &str,
) -> HttpResponse {
    let Some(pending) = state::take_pending_state(oauth_state) else {
        return HttpResponse::text(400, "unknown or already-used state parameter");
    };
    if pending.provider != provider_from_path {
        return HttpResponse::text(
            400,
            "state parameter does not match this callback's provider",
        );
    }
    let now = ic_cdk::api::time();
    if pending.created_at + PENDING_STATE_TTL_SECS * 1_000_000_000 < now {
        return HttpResponse::text(400, "this login attempt has expired - please try again");
    }

    let config = state::get_config();
    let Some(provider_config) = config.providers.get(&pending.provider) else {
        return HttpResponse::text(
            500,
            format!("provider '{}' is no longer configured", pending.provider),
        );
    };

    let user_info = match oauth::exchange_code(provider_config, code).await {
        Ok(info) => info,
        Err(e) => return HttpResponse::text(502, format!("could not complete sign-in: {e}")),
    };

    let profile = match resolve_profile(&pending, &user_info, now) {
        Ok(profile) => profile,
        Err(e) => return HttpResponse::text(409, e),
    };

    let token = match random_token().await {
        Ok(t) => t,
        Err(e) => return HttpResponse::text(500, e),
    };
    let session_ttl_secs = match runtime_session_ttl_secs() {
        Ok(value) => value,
        Err(e) => return HttpResponse::text(500, e),
    };
    state::create_session(
        token.clone(),
        profile.id,
        now + session_ttl_secs * 1_000_000_000,
    );

    match runtime_frontend_redirect_url() {
        Some(url) => HttpResponse::redirect(&format!("{url}?session={token}")),
        None => HttpResponse::html(
            200,
            format!(
                "<p>Signed in as {}. Session token: <code>{token}</code></p>",
                user_info.name.as_deref().unwrap_or("(no name)")
            ),
        ),
    }
}

/// Finds or creates the `Profile` a completed OAuth exchange belongs to -
/// the "linking" vs. "fresh sign-in" branch described in `begin_oauth`'s
/// own doc comment.
fn resolve_profile(
    pending: &state::PendingOAuthState,
    user_info: &oauth::UserInfo,
    now: u64,
) -> Result<Profile, String> {
    let link = OAuthLink {
        provider: pending.provider.clone(),
        subject: user_info.subject.clone(),
        email: user_info.email.clone(),
        linked_at: now,
    };

    if let Some(principal) = pending.linking_principal {
        if let Some(existing) = state::get_profile_by_oauth(&pending.provider, &user_info.subject) {
            if existing.principal != Some(principal) {
                return Err(
                    "this OAuth identity is already linked to a different account".to_string(),
                );
            }
            return Ok(existing); // Already linked - idempotent.
        }
        let mut profile = state::get_profile_by_principal(&principal).unwrap_or_else(|| Profile {
            id: state::new_profile_id(),
            principal: Some(principal),
            display_name: user_info.name.clone(),
            email: user_info.email.clone(),
            avatar_url: user_info.picture.clone(),
            oauth_links: vec![],
            created_at: now,
            updated_at: now,
        });
        profile
            .oauth_links
            .retain(|l| l.provider != pending.provider);
        profile.oauth_links.push(link);
        profile.updated_at = now;
        state::insert_profile(profile.clone());
        return Ok(profile);
    }

    if let Some(existing) = state::get_profile_by_oauth(&pending.provider, &user_info.subject) {
        return Ok(existing); // Returning user signing in again.
    }

    let profile = Profile {
        id: state::new_profile_id(),
        principal: None,
        display_name: user_info.name.clone(),
        email: user_info.email.clone(),
        avatar_url: user_info.picture.clone(),
        oauth_links: vec![link],
        created_at: now,
        updated_at: now,
    };
    state::insert_profile(profile.clone());
    Ok(profile)
}

/// 32 real random bytes (`raw_rand` - a genuine IC-provided randomness
/// beacon, not a pseudo-random fallback), hex-encoded into an opaque
/// token - used for both CSRF `state` tokens and session tokens. Unguessable
/// is the only property either needs; nothing about the token's contents is
/// ever parsed back out.
async fn random_token() -> Result<String, String> {
    let bytes = ic_cdk::management_canister::raw_rand()
        .await
        .map_err(|e| format!("raw_rand failed: {e:?}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---------------------------------------------------------------------------
// Admin (controller-only)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_profile(id: u64) -> Result<Option<Profile>, String> {
    require_controller()?;
    Ok(state::get_profile(id))
}

/// Newest-first, paginated via `offset`/`limit`.
#[ic_cdk::query]
fn list_profiles(offset: u64, limit: u64) -> Result<Vec<Profile>, String> {
    require_controller()?;
    Ok(state::list_profiles(offset, limit))
}

#[ic_cdk::update]
fn set_oauth_provider(name: String, provider_config: OAuthProviderConfig) -> Result<(), String> {
    require_controller()?;
    let mut config = state::get_config();
    config.providers.insert(name, provider_config);
    state::set_config(config);
    Ok(())
}

#[ic_cdk::update]
fn remove_oauth_provider(name: String) -> Result<(), String> {
    require_controller()?;
    let mut config = state::get_config();
    config.providers.remove(&name);
    state::set_config(config);
    Ok(())
}

#[ic_cdk::update]
fn update_config(update: ConfigUpdate) -> Result<(), String> {
    require_controller()?;
    let mut dynamic = std::collections::HashMap::new();
    if let Some(ttl) = update.session_ttl_secs {
        let ttl = i64::try_from(ttl)
            .map_err(|_| "session_ttl_secs exceeds the dynamic config number range".to_string())?;
        dynamic.insert(
            "session_ttl_secs".to_owned(),
            canister_hub_sdk::ic::config::ConfigValue::Number(ttl),
        );
    }
    if let Some(Some(url)) = update.frontend_redirect_url.clone() {
        dynamic.insert(
            "frontend_redirect_url".to_owned(),
            canister_hub_sdk::ic::config::ConfigValue::Text(url),
        );
    } else if matches!(update.frontend_redirect_url, Some(None)) {
        canister_hub_sdk::ic::config::unset::<RuntimeConfig>("frontend_redirect_url")?;
    }
    if !dynamic.is_empty() {
        canister_hub_sdk::ic::config::set::<RuntimeConfig>(dynamic)?;
    }
    if let Some(trusted_canisters) = update.trusted_canisters {
        let mut config = state::get_config();
        config.trusted_canisters = trusted_canisters;
        state::set_config(config);
    }
    Ok(())
}

#[ic_cdk::query]
fn get_auth_config() -> Result<Config, String> {
    require_controller()?;
    let mut config = state::get_config();
    config.session_ttl_secs = runtime_session_ttl_secs()?;
    config.frontend_redirect_url = runtime_frontend_redirect_url();
    Ok(config)
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent (or a human
/// implementer) to consume - what it does, its security model, and how to
/// configure a real OAuth provider against it. Open to any caller, same
/// reasoning as every other building block's `llm_context`: nothing
/// sensitive in a description of the canister's own shape, and it needs to
/// be readable before anyone has credentials to call anything else here.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    #[test]
    fn principal_claims_require_controller_or_allowlisted_canister() {
        let caller = principal(1);
        assert!(may_resolve_principal_claims(&caller, true, &[]));
        assert!(may_resolve_principal_claims(&caller, false, &[caller]));
        assert!(!may_resolve_principal_claims(
            &caller,
            false,
            &[principal(2)]
        ));
    }
}

ic_cdk::export_candid!();
