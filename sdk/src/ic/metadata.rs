//! `canister_metadata`: a hardcoded, compile-time self-description any
//! canister can declare - name, description, and an optional
//! [`CanisterType`] (the canister's own identity, e.g. "I am an Auth
//! canister"). Deliberately decoupled from [`crate::ic::config`]'s dynamic-
//! config surface: a canister needs no `#[dynamic_config]` struct (or any
//! stable storage at all) to use this, and a `#[dynamic_config]` canister
//! that *does* use this gets two entirely independent candid surfaces, not
//! one feeding the other.
//!
//! Note this module's `CanisterType` is the same type `ic::config`'s
//! `CanisterPicker` fields use for their own `canister_type` filter - same
//! four values, different question: there, "what kind of canister does
//! *this field* expect a caller to pick"; here, "what kind of canister
//! *is this one*".
//!
//! ```rust,ignore
//! use canister_hub_sdk::ic::metadata::canister_metadata;
//!
//! canister_metadata!(
//!     name = "my-canister",
//!     description = "What this canister does.",
//!     canister_type = "auth",
//!     version = "2.0.0",
//! );
//! ```
//!
//! Generates one public query, `canister_metadata() -> CanisterMetadata`.
//! `name` is required; `description` (defaults to `""`) and `canister_type`
//! (defaults to `None`) are optional. `version` is optional too, and
//! defaults to the calling crate's own `CARGO_PKG_VERSION` (its
//! `Cargo.toml` `[package] version`, baked in by `env!` at compile time) -
//! pass it explicitly only when a canister's own meaningful version number
//! (e.g. one it also declares in `canister.yaml`'s `crate:version`
//! metadata) differs from its crate's semver. Every value here is baked
//! into the wasm at compile time - there's no stable storage and no
//! `set_canister_metadata`; nothing here can change without a new build.

use crate::ic::config::CanisterType;
use candid::CandidType;
use serde::Deserialize;

pub use canister_hub_sdk_macros::canister_metadata;

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CanisterMetadata {
    pub name: String,
    pub description: String,
    pub canister_type: Option<CanisterType>,
    pub version: String,
}
