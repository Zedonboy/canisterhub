//! Thin inter-canister client for the `ic-sql` canister (`packages/ic-sql`) -
//! the prebuilt SQL database a deployment of this template can be pointed at
//! via `Config::ic_sql_canister_id`.
//!
//! `query`/`execute` below are plain, independently callable async
//! functions - not `Tool`s themselves - deliberately, so a *different* tool
//! (now, or one you add later) can also read from, or write to, the
//! database as an implementation detail of its own logic, not only through
//! `tools.rs::QueryDatabaseTool`, which is just the model-facing wrapper
//! around `query`. For example, a real deployment might back `get_profile`
//! with a `SELECT` against a `customers` table here instead of (or as well
//! as) this template's own in-canister `state.rs` storage - `db::query`
//! is exactly what that tool's `call()` would reach for directly, with no
//! need to go through the model or duplicate the inter-canister-call
//! plumbing.
//!
//! `SqlValue`/`QueryResult` here are field-for-field identical to `ic-sql`'s
//! own candid types - candid matches by shape, not by the two crates
//! sharing a Rust type (the same convention `outbound.rs` uses for
//! `connector`'s types, for the same reason: depending on `ic-sql` as a
//! Rust library instead would pull its own `#[ic_cdk::update]`/`#[query]`
//! endpoints into this crate's compilation, which - per `hnsw_index/
//! README.md`'s documented experience with the exact same situation for
//! `ic_hnsw` - either silently drops them from the compiled Wasm or, if
//! this crate ever declared same-named endpoints of its own, collides with
//! them at link time. A handful of duplicated candid type definitions is a
//! far smaller cost than either of those.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Boolean(bool),
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub rows_affected: u64,
    pub message: String,
}

/// Runs a read-only `SELECT` against `ic_sql_canister_id`, via its `query`
/// endpoint - which itself rejects anything but a `SELECT` (see `ic-sql`'s
/// own doc comment), so this is enforced on the database's side too, not
/// only by `QueryDatabaseTool` calling this instead of [`execute`].
pub async fn query(ic_sql_canister_id: Principal, sql: &str) -> Result<QueryResult, String> {
    call(ic_sql_canister_id, "query", sql).await
}

/// Runs any statement - including a mutation - against `ic_sql_canister_id`,
/// via its `execute` endpoint. Not called by `QueryDatabaseTool` (see
/// `tools.rs`'s doc comment for why the model-facing tool is deliberately
/// read-only) - exposed here for a tool's own internal logic to use, the
/// same way `query` is. Nothing in this template calls it yet (by design -
/// see `tools.rs`'s doc comment on why a *write* path needs its own tool,
/// not a loosened `QueryDatabaseTool`), hence the explicit `allow` below.
#[allow(dead_code)]
pub async fn execute(ic_sql_canister_id: Principal, sql: &str) -> Result<QueryResult, String> {
    call(ic_sql_canister_id, "execute", sql).await
}

async fn call(ic_sql_canister_id: Principal, method: &str, sql: &str) -> Result<QueryResult, String> {
    let response = ic_cdk::call::Call::bounded_wait(ic_sql_canister_id, method)
        .with_arg(sql.to_string())
        .await
        .map_err(|e| format!("call to ic-sql.{method} failed: {e:?}"))?;
    response.candid::<Result<QueryResult, String>>().map_err(|e| format!("failed to decode ic-sql.{method}'s response: {e}"))?
}
