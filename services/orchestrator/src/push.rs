//! Web Push support - VAPID key config lives here; the orchestrator owns
//! the HTTP surface and auth, but **persistence of the actual subscription
//! records lives on `backend`**, not here (see `push_subscribe`/
//! `push_unsubscribe`/`push_list_subscriptions` in `src/ic/marketplace.rs`,
//! called controller-gated the same way `register_repo_publisher` is).
//! `backend` is the project's one durable, shared store - a local file here
//! would be per-process and lost on redeploy, which a canister's stable
//! memory isn't.
//!
//! No sending is implemented yet - only subscribe/unsubscribe/list exist.
//! Sending a real push (ECDSA-signing a VAPID JWT with
//! `Config::vapid_private_key` and POSTing the encrypted payload to each
//! subscription's own push service) is the obvious next step once
//! something decides *when* to notify a user - not built here.

use crate::config::Config;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::CandidType;
use serde::{Deserialize, Serialize};

/// The real shape the browser's `PushSubscription.toJSON()` returns -
/// candid-encoded wire-for-wire with `backend::PushSubscription`, which it
/// must stay identical to.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// Decodes `Config::vapid_public_key` (base64url, no padding - the standard
/// VAPID key encoding, what `examples/generate_vapid_keys.rs` prints) into
/// the raw 65-byte uncompressed SEC1 point the browser's
/// `PushManager.subscribe({ applicationServerKey })` expects. `None` if
/// unset or malformed - push stays a disabled feature in that case, not a
/// startup failure (same optionality as `Config::cycles_wallet_canister_id`:
/// only needed for one feature, not every deployment).
pub fn decode_vapid_public_key(config: &Config) -> Option<Vec<u8>> {
    let encoded = config.vapid_public_key.as_deref()?;
    URL_SAFE_NO_PAD.decode(encoded).ok()
}
