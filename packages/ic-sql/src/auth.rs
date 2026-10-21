//! Caller authorization: this canister's own internal permission data
//! (`set_permission`/`remove_permission`/`list_permissions` in `lib.rs`),
//! optionally backed by a sibling `auth` canister (`packages/auth`) for
//! callers with no explicit entry of their own.
//!
//! ## The model
//!
//! Every caller resolves to exactly one [`PermissionLevel`]:
//! - **`Blocked`** - no calls at all, neither `execute` nor `query`.
//! - **`ReadOnly`** - `query` (SELECT-only already, structurally) is fine;
//!   `execute` is rejected regardless of what SQL it's given, even a
//!   harmless `SELECT` - `execute` is this canister's read-*write* endpoint,
//!   a `ReadOnly` caller should use `query` instead.
//! - **`ReadWrite`** - both endpoints, no restriction.
//!
//! [`decide`] is the pure decision function - see its own doc comment for
//! exactly how an explicit local entry, the anonymous principal, and an
//! optional `auth` canister lookup combine into one of these. It takes no
//! `ic_cdk`/canister-runtime input and touches no `thread_local`, so it's
//! fully unit-testable the same way `engine::apply` is (see this crate's
//! `engine.rs` doc comment) - all the actual *decision* logic lives here in
//! one place, checkable without a canister runtime or a real `auth` canister
//! to call out to.
//!
//! The two scenarios this module exists for:
//! - **A blocked user cannot make RW calls to the database** - a controller
//!   calls `set_permission(user, Blocked)`; every subsequent `execute` (and
//!   `query`) from that principal is rejected outright, checked first and
//!   unconditionally in [`decide`].
//! - **A public (anonymous) caller can only make read calls** - with no
//!   explicit entry for the anonymous principal, [`decide`] hard-caps it at
//!   `ReadOnly` - `execute` always rejects it, `query` always allows it
//!   (subject to its own existing SELECT-only restriction).

use crate::rls::AuthContext;
use candid::{CandidType, Deserialize, Principal};

#[derive(Clone, Copy, Debug, CandidType, serde::Serialize, Deserialize, PartialEq, Eq)]
pub enum PermissionLevel {
    Blocked,
    ReadOnly,
    ReadWrite,
}

/// Decides the access level a caller has for one call, from three inputs:
///
/// - `explicit`: this canister's own internal permission-data entry for the
///   caller, if a controller has ever set one via `set_permission` - see
///   `lib.rs`. Always wins outright when present, `Blocked` included: a
///   controller's explicit call is never second-guessed by anything else
///   here, not even for the anonymous principal (a controller may
///   deliberately grant or block it too).
/// - `caller`: consulted only when there's no explicit entry, to hard-cap
///   the anonymous principal at `ReadOnly` - the "public user" scenario in
///   this module's doc comment. `auth_lookup` is never consulted for it
///   either; an unauthenticated caller is never worth an inter-canister
///   call to ask about.
/// - `auth_lookup`: `None` when no `auth` canister is configured for this
///   default case (or the caller is anonymous); `Some(recognized)` when one
///   is configured and was actually called, `recognized` being whether it
///   returned a real identity for this caller. A non-anonymous caller with
///   no explicit entry and no recognized identity defaults to `ReadOnly`
///   rather than `ReadWrite` - the same treatment as an anonymous caller.
///   This means wiring up an `auth` canister without granting or blocking
///   anyone narrows the *default* for everyone it doesn't recognize from
///   "may write" down to "read-only", without touching a single
///   `set_permission` entry.
pub fn decide(
    explicit: Option<PermissionLevel>,
    caller: Principal,
    auth_lookup: Option<bool>,
) -> PermissionLevel {
    if let Some(level) = explicit {
        return level;
    }
    if caller == Principal::anonymous() {
        return PermissionLevel::ReadOnly;
    }
    match auth_lookup {
        None | Some(true) => PermissionLevel::ReadWrite,
        Some(false) => PermissionLevel::ReadOnly,
    }
}

/// Structural copy of the `auth` canister's own `Authorization` wire shape
/// (see `packages/auth/auth.did`) - only enough of it to tell "recognized"
/// (`Some`) from "not" (`None`) apart, which is all [`probe_auth_canister`]
/// needs. Keeping this local instead of depending on the `auth` crate
/// avoids linking its exported canister entry points into this Wasm - the
/// same tradeoff `packages/app_api/src/auth.rs`'s own client makes (see its
/// doc comment).
#[derive(CandidType, Deserialize)]
struct AuthCanisterAuthorization {
    profile_id: u64,
    principal: Option<Principal>,
}

async fn authorization_call<T: CandidType>(
    auth_canister: Principal,
    method: &'static str,
    argument: T,
) -> Result<AuthContext, String> {
    let response = ic_cdk::call::Call::bounded_wait(auth_canister, method)
        .with_arg(argument)
        .await
        .map_err(|error| format!("auth.{method} call failed: {error}"))?;
    let authorization = response
        .candid::<Option<AuthCanisterAuthorization>>()
        .map_err(|error| format!("auth.{method} returned an incompatible response: {error}"))?
        .ok_or_else(|| "identity is not recognized or the session has expired".to_string())?;
    Ok(AuthContext {
        profile_id: authorization.profile_id,
        principal: authorization.principal,
    })
}

pub async fn authenticate_principal(
    auth_canister: Principal,
    principal: Principal,
) -> Result<AuthContext, String> {
    if principal == Principal::anonymous() {
        return Err("anonymous caller is not authenticated".to_string());
    }
    authorization_call(auth_canister, "authorize_principal", principal).await
}

pub async fn authenticate_session(
    auth_canister: Principal,
    token: String,
) -> Result<AuthContext, String> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid bearer session token".to_string());
    }
    authorization_call(auth_canister, "authorize_session", token).await
}

/// Calls the configured `auth` canister's `authorize_principal` query to
/// check whether it recognizes `caller` as a real identity.
///
/// `false` on anything short of a definite "yes" - a call failure (network,
/// trap, an incompatible response) is treated exactly like "not
/// recognized", never propagated as an error up to the `execute`/`query`
/// caller. An unreachable or misconfigured `auth` canister must never
/// *grant* write access by accident; the worst it can do is narrow a
/// caller down to read-only (see `decide`'s doc comment) - failing the
/// whole call instead would make this canister's own availability depend on
/// another canister's, which is a strictly worse failure mode than "writes
/// are briefly unavailable, reads still work."
pub async fn probe_auth_canister(auth_canister: Principal, caller: Principal) -> bool {
    let response = match ic_cdk::call::Call::bounded_wait(auth_canister, "authorize_principal")
        .with_arg(caller)
        .await
    {
        Ok(response) => response,
        Err(_) => return false,
    };
    response
        .candid::<Option<AuthCanisterAuthorization>>()
        .map(|opt| opt.is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    #[test]
    fn explicit_blocked_always_wins() {
        assert_eq!(
            decide(Some(PermissionLevel::Blocked), principal(1), Some(true)),
            PermissionLevel::Blocked
        );
        assert_eq!(
            decide(Some(PermissionLevel::Blocked), Principal::anonymous(), None),
            PermissionLevel::Blocked
        );
    }

    #[test]
    fn explicit_level_wins_over_a_recognized_auth_lookup() {
        // A controller's explicit ReadOnly caps a caller even if the auth
        // canister would otherwise vouch for them.
        assert_eq!(
            decide(Some(PermissionLevel::ReadOnly), principal(1), Some(true)),
            PermissionLevel::ReadOnly
        );
    }

    #[test]
    fn explicit_read_write_wins_even_for_the_anonymous_principal() {
        assert_eq!(
            decide(
                Some(PermissionLevel::ReadWrite),
                Principal::anonymous(),
                None
            ),
            PermissionLevel::ReadWrite
        );
    }

    #[test]
    fn anonymous_with_no_explicit_entry_defaults_to_read_only() {
        assert_eq!(
            decide(None, Principal::anonymous(), None),
            PermissionLevel::ReadOnly
        );
        // Even if somehow paired with a positive auth_lookup - anonymous is
        // never elevated by one (see `decide`'s doc comment: it's checked
        // first and auth_lookup is ignored for it).
        assert_eq!(
            decide(None, Principal::anonymous(), Some(true)),
            PermissionLevel::ReadOnly
        );
    }

    #[test]
    fn no_auth_canister_configured_defaults_a_real_caller_to_read_write() {
        // Backward-compatible with this canister's original behavior before
        // the auth feature existed: no access control at all by default.
        assert_eq!(decide(None, principal(1), None), PermissionLevel::ReadWrite);
    }

    #[test]
    fn an_auth_canister_that_recognizes_the_caller_defaults_to_read_write() {
        assert_eq!(
            decide(None, principal(1), Some(true)),
            PermissionLevel::ReadWrite
        );
    }

    #[test]
    fn an_auth_canister_that_does_not_recognize_the_caller_defaults_to_read_only() {
        assert_eq!(
            decide(None, principal(1), Some(false)),
            PermissionLevel::ReadOnly
        );
    }
}
