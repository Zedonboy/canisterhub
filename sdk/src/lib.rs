//! Typed clients for the `ic-sql`, `ic-kv`, and `auth` canisters shipped by
//! canister_hub.
//!
//! The crate deliberately owns copies of the Candid-facing types instead of
//! depending on the canister crates. Linking a canister crate into a consumer
//! can also link its exported IC entry points; keeping the wire types here
//! avoids that collision while Candid still checks their structural shape.

mod error;
mod project;

#[cfg(any(feature = "client", feature = "ic"))]
mod transport;

#[cfg(any(feature = "client", feature = "ic"))]
pub mod auth;
#[cfg(any(feature = "client", feature = "ic"))]
pub mod kv;
pub mod permissions;
#[cfg(any(feature = "client", feature = "ic"))]
pub mod sql;

#[cfg(feature = "ic")]
pub mod ic;

#[cfg(all(feature = "browser", target_arch = "wasm32"))]
#[path = "wasm.rs"]
pub mod browser;

#[cfg(feature = "client")]
pub mod client;

pub use candid::Principal;
pub use error::{Error, Result};
pub use project::{ProjectCanister, ProjectContext};

#[cfg(any(feature = "client", feature = "ic"))]
pub use auth::AuthClient;
