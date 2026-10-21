//! Native/off-chain clients backed by `ic-agent`. Gated in `lib.rs` by
//! `#[cfg(feature = "client")]`.
//!
//! `auth`/`kv`/`sql`/`permissions` stay defined at the crate root rather
//! than duplicated under both `client` and [`crate::ic`]: each exposes one
//! client type (`AuthClient`, `KvClient`, `SqlClient`, `PermissionClient`)
//! whose RPC methods are transport-agnostic - they just call through
//! [`crate::transport::CanisterClient`], which is what actually picks
//! `ic-agent` vs. bounded `ic-cdk` calls per-`Backend`. Only the
//! constructors differ, and those are already individually
//! `#[cfg(feature = "client")]`/`#[cfg(feature = "ic")]`-gated inside each
//! file. Duplicating the ~90% shared method bodies into separate
//! `client`-only and `ic`-only copies would just be two implementations to
//! keep in sync for no behavioral difference - this module re-exports the
//! shared types instead.
pub use crate::auth::AuthClient;
pub use crate::kv::KvClient;
pub use crate::permissions::PermissionClient;
pub use crate::sql::SqlClient;
pub use crate::{auth, kv, permissions, sql};
