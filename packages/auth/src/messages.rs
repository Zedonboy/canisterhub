//! The candid shapes this canister stores and returns: a `Profile` (one
//! user, reachable either by an IC principal it's linked to or by any
//! number of OAuth identities it's linked to - see `lib.rs`'s doc comment
//! for the two-path design), and the small records around it.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// One external identity provider account linked to a `Profile` - a
/// profile can have several (e.g. both "google" and "github"), each
/// contributing at most one link, keyed by `(provider, subject)` in
/// `state.rs`'s own index.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OAuthLink {
    pub provider: String,
    /// The provider's own stable id for this user (OIDC's "sub" claim, or
    /// whatever the equivalent field is called - see `oauth::find_subject`) -
    /// never the user's email, which a provider may let its users change.
    pub subject: String,
    /// The email `oauth::exchange_code` read back from this provider at
    /// link time - a snapshot, not re-verified on every login; a real
    /// deployment that needs a always-current email should re-fetch it.
    pub email: Option<String>,
    pub linked_at: u64,
}

/// One user. Reachable two ways - see `lib.rs`'s module doc comment for
/// the full design:
/// - by `principal`, if this profile has ever been linked to an IC
///   identity (`link_current_principal`) - `None` for an OAuth-only
///   account that has never done that.
/// - by a session token (`state.rs::SessionRecord`), issued each time an
///   OAuth login completes - looked up via `get_profile_by_session`.
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

/// Minimal proof that this auth canister currently recognizes an identity.
/// Private profile fields are intentionally excluded.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub profile_id: u64,
    pub principal: Option<Principal>,
}

/// Basic profile attributes suitable for application modules. OAuth links
/// and provider-specific subjects stay private to the auth canister.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProfileClaims {
    pub profile_id: u64,
    pub principal: Option<Principal>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

impl From<&Profile> for ProfileClaims {
    fn from(profile: &Profile) -> Self {
        Self {
            profile_id: profile.id,
            principal: profile.principal,
            display_name: profile.display_name.clone(),
            email: profile.email.clone(),
            avatar_url: profile.avatar_url.clone(),
        }
    }
}

/// `update_my_profile`'s argument - only the fields a user may set about
/// themselves (never `email`: that comes from a verified OAuth provider or
/// stays unset, never a value the user can just assert - see
/// `lib.rs::update_my_profile`). Three-state per field, matching every
/// other building block's `ConfigUpdate` convention (see
/// `connector::config::ConfigUpdate`'s doc comment): outer `None` leaves
/// the field untouched, `Some(None)` clears it, `Some(Some(value))` sets
/// it.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct UpdateProfile {
    pub display_name: Option<Option<String>>,
    pub avatar_url: Option<Option<String>>,
}
