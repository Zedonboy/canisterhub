//! All canister-side (as opposed to off-chain `client`/`browser`)
//! implementations: clients and storage primitives backed by IC system
//! APIs. Gated in `lib.rs` by `#[cfg(feature = "ic")]`, so nothing in here
//! (or anywhere below it) needs its own per-item feature gate.

use crate::Principal;
use std::cell::RefCell;
use std::collections::BTreeMap;

pub use crate::{
    auth::AuthClient,
    kv::KvClient,
    permissions,
    permissions::{Access, PermissionClient, PermissionEntry, PermissionStore},
    sql::SqlClient,
};

pub mod config;
pub mod metadata;

thread_local! {
    static AUTH_CLIENTS: RefCell<BTreeMap<Principal, AuthClient>> = const { RefCell::new(BTreeMap::new()) };
}

/// Returns one shared auth client per canister id. Sharing is important:
/// its profile cache then survives across messages until an upgrade.
pub fn auth(canister_id: Principal) -> AuthClient {
    AUTH_CLIENTS.with(|clients| {
        clients
            .borrow_mut()
            .entry(canister_id)
            .or_insert_with(|| AuthClient::for_canister(canister_id))
            .clone()
    })
}

/// Orthogonal stable-memory building blocks for IC implementations.
/// Consumers choose their own unique `MemoryId`s to avoid collisions.
pub mod storage {
    pub use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
    pub use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, StableLog};
}
