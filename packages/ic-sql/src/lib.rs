//! ic-sql: a small Internet Computer canister that behaves like a
//! PostgreSQL-dialect SQL database - `execute`/`query` take a SQL string and
//! run it directly, no client library, connection, or schema-migration
//! tooling required.
//!
//! The query engine ([`engine`]) remains a pure, side-effect-free
//! "functional core": every SQL statement is executed as a deterministic
//! transformation from one immutable `Database` value to the next (see
//! `engine.rs`'s doc comment) - nothing in that module ever mutates state in
//! place or reaches into a `thread_local`. This module is the thin
//! imperative shell around it: every endpoint below is just "load the current
//! stable records into an engine view, call `engine::apply`, commit the diff" - after first
//! checking the caller is actually allowed to (see [`auth`]). The
//! imperative storage shell is [`storage`], backed directly by stable maps.
//!
//! ## Persistence
//!
//! Tables, the name index, columns, and rows are separate stable structures.
//! Rows are keyed by `(table_id, row_id)`, so writes update individual stable
//! records and upgrades require no whole-database serialization. The pure
//! engine receives a heap view for one call; only its diff is committed.
//! Config and permissions also live directly in stable memory.
//!
//! ## Authorization
//!
//! See [`auth`]'s module doc comment for the full model. In short: an
//! explicit `set_permission` entry always wins; failing that, the anonymous
//! principal is always read-only, and every other caller is read-write
//! unless an `auth_canister` is configured through the dynamic config API
//! after deploy and
//! doesn't recognize them, in which case they're read-only too.

mod assets;
mod auth;
mod config;
mod engine;
mod http;
mod rls;
mod storage;

pub use auth::PermissionLevel;
pub use config::{Config, ConfigUpdate};
pub use engine::{
    CheckConstraint, ColumnDef, ColumnDefault, ConstraintDescription, ForeignKeyAction,
    ForeignKeyConstraint, IndexDefinition, QueryResult, RelationalConstraints, SqlValue,
    TableDescription, UniqueConstraint,
};
pub use http::{HttpRequest, HttpResponse};
pub use rls::RlsPolicy;

use candid::Principal;
use storage::PermissionStorage;
const DATABASE_PERMISSION_MODULE: &str = "database";

canister_hub_sdk::permission_api!(PermissionStorage);

canister_hub_sdk::ic::metadata::canister_metadata!(
    name = "ic-sql",
    description = "PostgreSQL-dialect relational database canister with stable storage, permissions, dynamic configuration, and row-level security.",
    canister_type = "database",
    // Matches `canister.yaml`'s own `crate:version` metadata - keep both
    // in sync by hand when bumping either.
    version = "2.0.0",
);

fn require_controller() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err("only a controller may call this method".to_string())
    }
}

fn explicit_permission(caller: &Principal) -> Option<PermissionLevel> {
    storage::get_permission(caller)
}

/// Resolves the calling principal's access level - see `auth::decide`'s doc
/// comment for exactly how this combines an explicit `set_permission` entry,
/// the anonymous principal, and (only when neither of those already settles
/// it) a live call to the configured `auth_canister`.
async fn resolve_permission(caller: Principal) -> PermissionLevel {
    let explicit = explicit_permission(&caller);
    if explicit.is_some() || caller == Principal::anonymous() {
        return auth::decide(explicit, caller, None);
    }
    let auth_canister = canister_hub_sdk::ic::config::get_env_principal("auth_canister");
    let auth_lookup = match auth_canister {
        None => None,
        Some(id) => Some(auth::probe_auth_canister(id, caller).await),
    };
    auth::decide(explicit, caller, auth_lookup)
}

fn configured_auth_canister() -> Result<Principal, String> {
    canister_hub_sdk::ic::config::get_env_principal("auth_canister")
        .ok_or_else(|| "RLS requires Config.auth_canister to be configured".to_string())
}

async fn authenticate_caller(caller: Principal) -> Result<rls::AuthContext, String> {
    auth::authenticate_principal(configured_auth_canister()?, caller).await
}

async fn authenticate_session(token: String) -> Result<rls::AuthContext, String> {
    auth::authenticate_session(configured_auth_canister()?, token).await
}

fn permission_for_verified_identity(context: &rls::AuthContext) -> PermissionLevel {
    context
        .principal
        .as_ref()
        .and_then(explicit_permission)
        .unwrap_or(PermissionLevel::ReadWrite)
}

fn rls_policy_for_sql(sql: &str) -> Result<Option<RlsPolicy>, String> {
    let tables = engine::statement_tables(sql)?;
    let primary = tables.first();
    let protected = tables
        .iter()
        .filter_map(|table| storage::get_rls_policy(table).map(|policy| (table, policy)))
        .collect::<Vec<_>>();
    if protected.iter().any(|(table, _)| Some(*table) != primary) {
        return Err("JOINs may not read an RLS-protected secondary table; make the protected table the primary FROM source or split the query".to_string());
    }
    Ok(protected.into_iter().next().map(|(_, policy)| policy))
}

fn apply_sql(
    database: &engine::Database,
    sql: &str,
    context: Option<&rls::AuthContext>,
    admin_bypass: bool,
) -> Result<(engine::Database, QueryResult), String> {
    let outcome = if admin_bypass {
        engine::apply(database, sql)
    } else if let Some(policy) = rls_policy_for_sql(sql)? {
        let context = context.ok_or_else(|| {
            "row-level security requires authentication; use query_authenticated or a bearer session"
                .to_string()
        })?;
        let subject = context.subject_key();
        engine::apply_with_owner_policy(
            database,
            sql,
            engine::OwnerPolicy {
                owner_column: &policy.owner_column,
                subject: &subject,
            },
        )
    } else {
        engine::apply(database, sql)
    }?;
    if !admin_bypass {
        let primary = engine::statement_tables(sql)?.into_iter().next();
        for policy in storage::list_rls_policies() {
            if Some(policy.table_name.clone()) != primary
                && database.tables.get(&policy.table_name)
                    != outcome.0.tables.get(&policy.table_name)
            {
                return Err(format!(
                    "referential action would modify RLS-protected table '{}'; use a controller migration or choose RESTRICT",
                    policy.table_name
                ));
            }
        }
    }
    for policy in storage::list_rls_policies() {
        if let Some(table) = outcome.0.tables.get(&policy.table_name) {
            if !table
                .columns
                .iter()
                .any(|column| column.name == policy.owner_column)
            {
                return Err(format!(
                    "schema change would remove RLS owner column '{}.{}'; disable or update the policy first",
                    policy.table_name, policy.owner_column
                ));
            }
        }
    }
    Ok(outcome)
}

const MAX_BATCH_STATEMENTS: usize = 100;
const MAX_BATCH_SQL_BYTES: usize = 1024 * 1024;

fn validate_batch(statements: &[String]) -> Result<(), String> {
    if statements.is_empty() {
        return Err("batch must contain at least one statement".to_string());
    }
    if statements.len() > MAX_BATCH_STATEMENTS {
        return Err(format!(
            "batch exceeds the maximum of {MAX_BATCH_STATEMENTS} statements"
        ));
    }
    let bytes = statements.iter().map(String::len).sum::<usize>();
    if bytes > MAX_BATCH_SQL_BYTES {
        return Err("batch SQL exceeds 1 MiB".to_string());
    }
    Ok(())
}

fn batch_uses_rls(statements: &[String]) -> Result<bool, String> {
    statements.iter().try_fold(false, |found, sql| {
        Ok(found || rls_policy_for_sql(sql)?.is_some())
    })
}

fn apply_batch(
    initial: &engine::Database,
    statements: &[String],
    context: Option<&rls::AuthContext>,
    admin_bypass: bool,
) -> Result<(engine::Database, Vec<QueryResult>), String> {
    validate_batch(statements)?;
    let mut database = initial.clone();
    let mut results = Vec::with_capacity(statements.len());
    for (index, sql) in statements.iter().enumerate() {
        let (next, result) = apply_sql(&database, sql, context, admin_bypass)
            .map_err(|error| format!("statement {} failed: {error}", index + 1))?;
        database = next;
        results.push(result);
    }
    Ok((database, results))
}

// Config is intentionally not an init argument. The no-argument init hook at
// the bottom only opens the stable dynamic-config store; marketplace tooling
// supplies settings after installation.

/// Runs any SQL statement (DDL or DML - `CREATE TABLE`, `INSERT`, `UPDATE`,
/// `DELETE`, `DROP TABLE`, or `SELECT`) and persists its effect. Prefer
/// `query` for a read-only `SELECT` - it doesn't need to go through
/// consensus.
///
/// Requires `ReadWrite` access (see [`auth`]) - a `Blocked` caller is
/// rejected outright, and a `ReadOnly` one is rejected here regardless of
/// which statement it sent (even a harmless `SELECT`): this is the
/// read-*write* endpoint, `query` is the read-only one.
#[ic_cdk::update]
async fn execute(sql: String) -> Result<QueryResult, String> {
    let caller = ic_cdk::api::msg_caller();
    let admin_bypass = ic_cdk::api::is_controller(&caller);
    let context = if !admin_bypass && rls_policy_for_sql(&sql)?.is_some() {
        Some(authenticate_caller(caller).await?)
    } else {
        None
    };
    let permission = match context.as_ref() {
        Some(context) => permission_for_verified_identity(context),
        None => resolve_permission(caller).await,
    };
    match permission {
        PermissionLevel::Blocked => return Err("caller is blocked from this database".to_string()),
        PermissionLevel::ReadOnly => {
            return Err(
                "caller has read-only access; use `query` for SELECT statements".to_string(),
            )
        }
        PermissionLevel::ReadWrite => {}
    }
    let old_db = storage::load_database();
    let (new_db, result) = apply_sql(&old_db, &sql, context.as_ref(), admin_bypass)?;
    storage::commit_database(&old_db, &new_db);
    Ok(result)
}

/// Runs a read-only `SELECT`. Rejects anything else outright: an IC query
/// call's state changes are never committed regardless, so letting a
/// mutation through here would silently discard it instead of reporting an
/// error.
///
/// Only a `Blocked` caller is rejected here (see [`auth`]) - `ReadOnly` and
/// `ReadWrite` are both allowed, since this endpoint is already
/// structurally read-only regardless of which one a caller has.
#[ic_cdk::query]
fn query(sql: String) -> Result<QueryResult, String> {
    let caller = ic_cdk::api::msg_caller();
    if explicit_permission(&caller) == Some(PermissionLevel::Blocked) {
        return Err("caller is blocked from this database".to_string());
    }
    if !engine::is_read_only(&sql)? {
        return Err(
            "Only SELECT queries are allowed in query mode. Use 'execute' for mutations."
                .to_string(),
        );
    }
    let admin_bypass = ic_cdk::api::is_controller(&caller);
    apply_sql(
        &storage::load_database_for_query(&sql),
        &sql,
        None,
        admin_bypass,
    )
    .map(|(_, result)| result)
}

/// Authenticated SELECT endpoint for RLS tables. It is an update because
/// resolving a principal through the auth canister requires an inter-canister
/// call; the SQL itself remains read-only.
#[ic_cdk::update]
async fn query_authenticated(sql: String) -> Result<QueryResult, String> {
    if !engine::is_read_only(&sql)? {
        return Err("Only SELECT queries are allowed".to_string());
    }
    let caller = ic_cdk::api::msg_caller();
    let admin_bypass = ic_cdk::api::is_controller(&caller);
    let context = if !admin_bypass && rls_policy_for_sql(&sql)?.is_some() {
        let context = authenticate_caller(caller).await?;
        if permission_for_verified_identity(&context) == PermissionLevel::Blocked {
            return Err("caller is blocked from this database".to_string());
        }
        Some(context)
    } else {
        match resolve_permission(caller).await {
            PermissionLevel::Blocked => {
                return Err("caller is blocked from this database".to_string())
            }
            PermissionLevel::ReadOnly | PermissionLevel::ReadWrite => {}
        }
        None
    };
    apply_sql(
        &storage::load_database_for_query(&sql),
        &sql,
        context.as_ref(),
        admin_bypass,
    )
    .map(|(_, result)| result)
}

/// Session-token variants let OAuth-only identities use Candid while sharing
/// exactly the same RLS subject as REST bearer authentication.
#[ic_cdk::update]
async fn query_with_session(session_token: String, sql: String) -> Result<QueryResult, String> {
    if !engine::is_read_only(&sql)? {
        return Err("Only SELECT queries are allowed".to_string());
    }
    let context = authenticate_session(session_token).await?;
    if permission_for_verified_identity(&context) == PermissionLevel::Blocked {
        return Err("caller is blocked from this database".to_string());
    }
    apply_sql(
        &storage::load_database_for_query(&sql),
        &sql,
        Some(&context),
        false,
    )
    .map(|(_, result)| result)
}

#[ic_cdk::update]
async fn execute_with_session(session_token: String, sql: String) -> Result<QueryResult, String> {
    let context = authenticate_session(session_token).await?;
    match permission_for_verified_identity(&context) {
        PermissionLevel::Blocked => return Err("caller is blocked from this database".to_string()),
        PermissionLevel::ReadOnly => return Err("identity has read-only access".to_string()),
        PermissionLevel::ReadWrite => {}
    }
    let old_db = storage::load_database();
    let (new_db, result) = apply_sql(&old_db, &sql, Some(&context), false)?;
    storage::commit_database(&old_db, &new_db);
    Ok(result)
}

/// Executes up to 100 statements as one atomic transaction. Stable storage is
/// changed only after every statement and every constraint check succeeds.
#[ic_cdk::update]
async fn execute_batch(statements: Vec<String>) -> Result<Vec<QueryResult>, String> {
    validate_batch(&statements)?;
    let caller = ic_cdk::api::msg_caller();
    let admin_bypass = ic_cdk::api::is_controller(&caller);
    let context = if batch_uses_rls(&statements)? && !admin_bypass {
        Some(authenticate_caller(caller).await?)
    } else {
        None
    };
    let permission = match context.as_ref() {
        Some(context) => permission_for_verified_identity(context),
        None => resolve_permission(caller).await,
    };
    match permission {
        PermissionLevel::Blocked => return Err("caller is blocked from this database".to_string()),
        PermissionLevel::ReadOnly => return Err("caller has read-only access".to_string()),
        PermissionLevel::ReadWrite => {}
    }
    let old_database = storage::load_database();
    let (new_database, results) =
        apply_batch(&old_database, &statements, context.as_ref(), admin_bypass)?;
    storage::commit_database(&old_database, &new_database);
    Ok(results)
}

#[ic_cdk::update]
async fn execute_batch_with_session(
    session_token: String,
    statements: Vec<String>,
) -> Result<Vec<QueryResult>, String> {
    validate_batch(&statements)?;
    let context = authenticate_session(session_token).await?;
    match permission_for_verified_identity(&context) {
        PermissionLevel::Blocked => return Err("caller is blocked from this database".to_string()),
        PermissionLevel::ReadOnly => return Err("identity has read-only access".to_string()),
        PermissionLevel::ReadWrite => {}
    }
    let old_database = storage::load_database();
    let (new_database, results) = apply_batch(&old_database, &statements, Some(&context), false)?;
    storage::commit_database(&old_database, &new_database);
    Ok(results)
}

// ---------------------------------------------------------------------------
// Authorization configuration and permission data (controller-only)
// ---------------------------------------------------------------------------

/// Applies `update` to the current configuration - see `ConfigUpdate`'s doc
/// comment for its three-state-per-field semantics.
#[ic_cdk::update]
fn update_config(update: ConfigUpdate) -> Result<(), String> {
    require_controller()?;
    if let Some(Some(auth_canister)) = update.auth_canister {
        canister_hub_sdk::ic::config::set::<Config>(std::collections::HashMap::from([(
            "auth_canister".to_owned(),
            canister_hub_sdk::ic::config::ConfigValue::PrincipalId(auth_canister),
        )]))?;
    } else if matches!(update.auth_canister, Some(None)) {
        canister_hub_sdk::ic::config::unset::<Config>("auth_canister")?;
    }
    Ok(())
}

#[ic_cdk::query]
fn get_database_config() -> Result<Config, String> {
    require_controller()?;
    Ok(Config {
        auth_canister: canister_hub_sdk::ic::config::get_env_principal("auth_canister"),
    })
}

#[ic_cdk::update]
fn enable_rls(table_name: String, owner_column: String) -> Result<(), String> {
    require_controller()?;
    let table_name = table_name.to_lowercase();
    let owner_column = owner_column.to_lowercase();
    let table = storage::describe_table(&table_name)?;
    let column = table
        .columns
        .iter()
        .find(|column| column.name == owner_column)
        .ok_or_else(|| format!("Column '{owner_column}' not found"))?;
    let data_type = column.data_type.to_ascii_uppercase();
    if !["TEXT", "CHAR", "STRING"]
        .iter()
        .any(|kind| data_type.contains(kind))
    {
        return Err("RLS owner column must have a text type".to_string());
    }
    if canister_hub_sdk::ic::config::get_env_principal("auth_canister").is_none() {
        return Err("configure auth_canister before enabling RLS".to_string());
    }
    storage::set_rls_policy(RlsPolicy {
        table_name,
        owner_column,
    });
    Ok(())
}

#[ic_cdk::update]
fn disable_rls(table_name: String) -> Result<(), String> {
    require_controller()?;
    storage::remove_rls_policy(&table_name);
    Ok(())
}

#[ic_cdk::query]
fn list_rls_policies() -> Result<Vec<RlsPolicy>, String> {
    require_controller()?;
    Ok(storage::list_rls_policies())
}

#[ic_cdk::query]
fn list_tables() -> Vec<String> {
    storage::list_tables()
}

#[ic_cdk::query]
fn describe_table(table_name: String) -> Result<TableDescription, String> {
    if storage::get_rls_policy(&table_name).is_some()
        && !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller())
    {
        return Err(
            "protected table metadata is controller-only; use the REST API for authenticated rows"
                .to_string(),
        );
    }
    storage::describe_table(&table_name)
}

/// Controller-only fast path for a table-browser-style admin UI to page
/// through a table's rows: no SQL text, no parser, and no full-database
/// load (see `storage::table_rows`) - just this table's own rows, directly
/// out of stable storage. Deliberately controller-only rather than routed
/// through the general `ReadOnly`/`ReadWrite`/RLS permission model `query`
/// respects: it exists for this canister's own admin tooling, not as a
/// second general-purpose read endpoint for arbitrary callers. Use `query`
/// (or the REST API) for anything that needs to respect per-caller
/// permissions or RLS.
#[ic_cdk::query]
fn get_table_rows(table_name: String, limit: u64, offset: u64) -> Result<QueryResult, String> {
    require_controller()?;
    const MAX_ROWS_PER_PAGE: u64 = 500;
    let (columns, rows) = storage::table_rows(&table_name, limit.min(MAX_ROWS_PER_PAGE), offset)?;
    let rows: Vec<Vec<SqlValue>> = rows.into_iter().map(|row| row.values).collect();
    Ok(QueryResult {
        columns: columns.into_iter().map(|c| c.name).collect(),
        rows_affected: rows.len() as u64,
        rows,
        message: String::new(),
    })
}

#[ic_cdk::query]
fn describe_constraints(table_name: String) -> Result<ConstraintDescription, String> {
    if storage::get_rls_policy(&table_name).is_some()
        && !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller())
    {
        return Err("protected table metadata is controller-only".to_string());
    }
    storage::describe_constraints(&table_name)
}

/// PostgREST gateway entry point, plus the embedded `table-browser` static
/// UI for any path outside it (see `assets.rs`). Mutations and every
/// RLS-protected request return `upgrade=true` so authentication and row
/// access run in an update.
#[ic_cdk::query]
fn http_request(request: HttpRequest) -> HttpResponse {
    http::query(request)
}

/// Consensus-backed half of the REST interface. RLS routes validate a bearer
/// session here; unprotected writes retain the anonymous-permission behavior.
#[ic_cdk::update]
async fn http_request_update(request: HttpRequest) -> HttpResponse {
    http::update(request).await
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent (or a human caller)
/// to consume - what it does, exactly which SQL it supports (and, just as
/// important, which it silently doesn't), and its persistence tradeoffs.
/// Open to any caller: nothing sensitive in a description of the canister's
/// own shape, and it needs to be readable before anyone has a reason to
/// call anything else here.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

// ---------------------------------------------------------------------------
// Stable structures reopen themselves on upgrade. This hook only handles the
// one-time migration from the former snapshot format; it never serializes the
// new stable-map state into one heap-sized value.
// ---------------------------------------------------------------------------

#[ic_cdk::init]
fn init(_project_context: canister_hub_sdk::ProjectContext) {
    storage::init_dynamic_config_store();
    assets::certify();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    storage::migrate_legacy_snapshot_if_present();
    storage::init_dynamic_config_store();
    assets::certify();
}

ic_cdk::export_candid!();

#[cfg(test)]
mod relational_tests {
    use super::*;

    #[test]
    fn metadata_declares_database_canister_type() {
        let metadata = canister_metadata();
        assert_eq!(metadata.name, "ic-sql");
        assert_eq!(
            metadata.canister_type,
            Some(canister_hub_sdk::ic::config::CanisterType::Database)
        );
    }

    #[test]
    fn batch_is_atomic_when_a_later_statement_fails() {
        let initial = engine::Database::default();
        let statements = vec![
            "CREATE TABLE batch_accounts (id INT PRIMARY KEY)".to_string(),
            "INSERT INTO batch_accounts VALUES (1)".to_string(),
            "INSERT INTO batch_accounts VALUES (1)".to_string(),
        ];
        assert!(apply_batch(&initial, &statements, None, false).is_err());
        assert!(engine::statement_table("SELECT * FROM batch_accounts").is_ok());
        assert!(
            initial.tables.is_empty(),
            "the input database must remain unchanged"
        );
    }

    #[test]
    fn successful_batch_returns_each_statement_result() {
        let initial = engine::Database::default();
        let statements = vec![
            "CREATE TABLE batch_ok (id INT PRIMARY KEY)".to_string(),
            "INSERT INTO batch_ok VALUES (1)".to_string(),
            "SELECT * FROM batch_ok".to_string(),
        ];
        let (database, results) = apply_batch(&initial, &statements, None, false).unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[2].rows, vec![vec![SqlValue::Integer(1)]]);
        assert!(database.tables.contains_key("batch_ok"));
    }
}
