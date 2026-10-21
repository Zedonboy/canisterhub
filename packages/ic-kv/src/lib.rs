//! ic-kv: a small Internet Computer canister that behaves like a key-value
//! store - `get`/`set`/`delete` a key directly, no client library or schema
//! required.
//!
//! Same architecture as `ic-sql` (see that package's README/`src/engine.rs`
//! doc comment for the full rationale): [`engine`] is a pure,
//! side-effect-free functional core - every operation is a deterministic
//! transformation from one immutable `Store` value to the next, and nothing
//! in that module mutates state in place or reaches into a `thread_local`.
//! This module is the thin imperative shell around it: it holds the one live
//! `Store` this canister instance has, and every endpoint below is just
//! "load the current store, call the matching `engine` function, store the
//! result back".
//!
//! ## Persistence
//!
//! Same tradeoff as `ic-sql`, for the same reason: the live `Store` lives in
//! ordinary heap memory and is serialized to stable memory in `pre_upgrade`,
//! restored in `post_upgrade`, via `ic_cdk::storage::stable_save`/
//! `stable_restore` (one whole-store snapshot, not an incremental
//! structure). Keeps the engine genuinely simple - one in-memory value - at
//! the cost of a practical ceiling on total data size (the whole store must
//! fit in heap memory and serialize within one upgrade's instruction
//! budget). A version meant to hold far more data would want
//! `ic_stable_structures::StableBTreeMap` instead.

mod engine;

pub use engine::Value;

use engine::{Snapshot, Store};
use std::cell::RefCell;

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(engine::new_store());
}

/// Sets `key` to `value`, returning whatever `key`'s value was before this
/// call (`null` if it didn't exist).
#[ic_cdk::update]
fn set(key: String, value: Value) -> Option<Value> {
    STORE.with(|store| {
        let (new_store, old) = engine::set(&store.borrow(), key, value);
        *store.borrow_mut() = new_store;
        old
    })
}

/// Sets every `(key, value)` pair in `entries` in one call, later entries
/// winning on a repeated key. Returns how many entries were set.
#[ic_cdk::update]
fn set_many(entries: Vec<(String, Value)>) -> u64 {
    STORE.with(|store| {
        let count = entries.len() as u64;
        let new_store = engine::set_many(&store.borrow(), entries);
        *store.borrow_mut() = new_store;
        count
    })
}

#[ic_cdk::query]
fn get(key: String) -> Option<Value> {
    STORE.with(|store| engine::get(&store.borrow(), &key))
}

/// Looks up several keys in one call, preserving order - a missing key comes
/// back as `null` in its slot rather than shrinking the result.
#[ic_cdk::query]
fn get_many(keys: Vec<String>) -> Vec<Option<Value>> {
    STORE.with(|store| engine::get_many(&store.borrow(), &keys))
}

/// Removes `key`, returning the value it held (`null` if it didn't exist).
#[ic_cdk::update]
fn delete(key: String) -> Option<Value> {
    STORE.with(|store| {
        let (new_store, old) = engine::delete(&store.borrow(), &key);
        *store.borrow_mut() = new_store;
        old
    })
}

#[ic_cdk::query]
fn exists(key: String) -> bool {
    STORE.with(|store| engine::exists(&store.borrow(), &key))
}

/// All keys, optionally restricted to ones starting with `prefix` - in
/// sorted order.
#[ic_cdk::query]
fn keys(prefix: Option<String>) -> Vec<String> {
    STORE.with(|store| engine::keys(&store.borrow(), prefix.as_deref()))
}

#[ic_cdk::query]
fn len() -> u64 {
    STORE.with(|store| engine::len(&store.borrow()))
}

/// Empties the store, returning how many entries it held.
#[ic_cdk::update]
fn clear() -> u64 {
    STORE.with(|store| {
        let (new_store, count) = engine::clear(&store.borrow());
        *store.borrow_mut() = new_store;
        count
    })
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent (or a human caller)
/// to consume - what it does, its API, and its persistence tradeoffs. Open
/// to any caller: nothing sensitive in a description of the canister's own
/// shape, and it needs to be readable before anyone has a reason to call
/// anything else here.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

// ---------------------------------------------------------------------------
// Upgrade persistence - see this module's doc comment
// ---------------------------------------------------------------------------

#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    let snapshot = STORE.with(|store| Snapshot::from(&*store.borrow()));
    ic_cdk::storage::stable_save((snapshot,)).expect("failed to save ic-kv state to stable memory");
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    let (snapshot,): (Snapshot,) = ic_cdk::storage::stable_restore().expect("failed to restore ic-kv state from stable memory");
    STORE.with(|store| *store.borrow_mut() = snapshot.into());
}

ic_cdk::export_candid!();
