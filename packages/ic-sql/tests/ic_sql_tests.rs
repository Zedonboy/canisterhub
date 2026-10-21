//! PocketIC integration tests for the `ic-sql` canister: `execute`/`query`
//! end to end through the real canister interface (not just the pure
//! `engine` unit tests in `src/engine.rs`, which never touch a canister
//! runtime at all), plus - the one thing those unit tests structurally can't
//! reach - that direct stable structures actually survive a canister upgrade
//! without `pre_upgrade` serialization, and that the auth feature's controller
//! gating and permission enforcement (`src/auth.rs`) hold up through the
//! real candid interface, not just `auth::decide`'s own pure unit tests.
//!
//! Requires a built canister Wasm at
//! `../target/wasm32-unknown-unknown/release/ic_sql.wasm` - build it first:
//!
//!   cargo build --target wasm32-unknown-unknown --release
//!   cargo test
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic

use candid::{encode_one, Principal};
use canister_hub_sdk::ic::config::{CanisterType, ConfigFieldSchema, ConfigType, ConfigValue};
use canister_hub_sdk::permissions::{Access, PermissionEntry};
use ic_sql::{Config, QueryResult};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use std::collections::HashMap;

fn anonymous() -> Principal {
    Principal::anonymous()
}

const IC_SQL_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/ic_sql.wasm"
));

fn caller() -> Principal {
    Principal::from_slice(&[7; 10])
}

fn other_user() -> Principal {
    Principal::from_slice(&[9; 10])
}

// Runtime configuration is supplied after install, so installation only
// passes a valid empty Candid argument tuple.
fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister_id = pic.create_canister_with_settings(Some(caller()), None);
    pic.add_cycles(canister_id, 10_000_000_000_000);
    pic.install_canister(
        canister_id,
        IC_SQL_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(caller()),
    );
    (pic, canister_id)
}

#[test]
fn dynamic_config_schema_sets_the_runtime_auth_canister() {
    let (pic, id) = setup();
    let (schema,): (Vec<ConfigFieldSchema>,) =
        query_candid_as(&pic, id, caller(), "get_config_schema", ()).unwrap();
    assert_eq!(schema.len(), 1);
    assert_eq!(schema[0].key, "auth_canister");
    assert_eq!(schema[0].canister_type, Some(CanisterType::Auth));
    assert!(matches!(
        schema[0].field_type,
        ConfigType::CanisterPicker { .. }
    ));

    let auth_canister = Principal::from_slice(&[3; 10]);
    let settings = HashMap::from([(
        "auth_canister".to_string(),
        ConfigValue::PrincipalId(auth_canister),
    )]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, id, caller(), "set_config", (settings,)).unwrap();
    result.unwrap();

    let (config,): (Result<Config, String>,) =
        query_candid_as(&pic, id, caller(), "get_database_config", ()).unwrap();
    assert_eq!(config.unwrap().auth_canister, Some(auth_canister));

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        caller(),
        "update_config",
        (ic_sql::ConfigUpdate {
            auth_canister: Some(None),
        },),
    )
    .unwrap();
    result.unwrap();
    let (config,): (Result<Config, String>,) =
        query_candid_as(&pic, id, caller(), "get_database_config", ()).unwrap();
    assert_eq!(config.unwrap().auth_canister, None);
}

fn execute_as(
    pic: &PocketIc,
    id: Principal,
    who: Principal,
    sql: &str,
) -> Result<QueryResult, String> {
    let (result,): (Result<QueryResult, String>,) =
        update_candid_as(pic, id, who, "execute", (sql.to_string(),)).unwrap();
    result
}

fn execute(pic: &PocketIc, id: Principal, sql: &str) -> Result<QueryResult, String> {
    execute_as(pic, id, caller(), sql)
}

fn query_as(
    pic: &PocketIc,
    id: Principal,
    who: Principal,
    sql: &str,
) -> Result<QueryResult, String> {
    let (result,): (Result<QueryResult, String>,) =
        query_candid_as(pic, id, who, "query", (sql.to_string(),)).unwrap();
    result
}

fn query(pic: &PocketIc, id: Principal, sql: &str) -> Result<QueryResult, String> {
    query_as(pic, id, caller(), sql)
}

fn list_tables(pic: &PocketIc, id: Principal) -> Vec<String> {
    let (tables,): (Vec<String>,) = query_candid_as(pic, id, caller(), "list_tables", ()).unwrap();
    tables
}

fn set_permission(
    pic: &PocketIc,
    id: Principal,
    who: Principal,
    target: Principal,
    access: Access,
) -> Result<(), String> {
    let entry = PermissionEntry {
        module: "database".to_string(),
        principal: target,
        access,
    };
    let (result,): (Result<(), String>,) =
        update_candid_as(pic, id, who, "set_permission", (entry,)).unwrap();
    result
}

// ---------------------------------------------------------------------------
// execute: DDL/DML end to end through the real canister interface
// ---------------------------------------------------------------------------

#[test]
fn create_insert_select_round_trip_through_the_canister_interface() {
    let (pic, id) = setup();

    let created = execute(&pic, id, "CREATE TABLE users (id INT, name TEXT)").unwrap();
    assert_eq!(created.message, "Table 'users' created successfully");

    let inserted = execute(
        &pic,
        id,
        "INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob')",
    )
    .unwrap();
    assert_eq!(inserted.rows_affected, 2);

    let selected = execute(&pic, id, "SELECT * FROM users WHERE id = 2").unwrap();
    assert_eq!(selected.rows_affected, 1);
    assert_eq!(selected.columns, vec!["id".to_string(), "name".to_string()]);

    assert_eq!(list_tables(&pic, id), vec!["users".to_string()]);
}

#[test]
fn update_and_delete_through_the_canister_interface() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT, status TEXT)").unwrap();
    execute(
        &pic,
        id,
        "INSERT INTO t VALUES (1, 'pending'), (2, 'pending')",
    )
    .unwrap();

    let updated = execute(&pic, id, "UPDATE t SET status = 'done' WHERE id = 1").unwrap();
    assert_eq!(updated.rows_affected, 1);

    let deleted = execute(&pic, id, "DELETE FROM t WHERE status = 'pending'").unwrap();
    assert_eq!(deleted.rows_affected, 1);

    let remaining = execute(&pic, id, "SELECT id, status FROM t").unwrap();
    assert_eq!(remaining.rows_affected, 1);
}

#[test]
fn a_failed_statement_reports_an_error_and_changes_nothing() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();

    let err = execute(&pic, id, "INSERT INTO nope VALUES (1)").unwrap_err();
    assert!(err.contains("not found"), "unexpected error: {err}");

    // The failed statement must not have created anything.
    assert_eq!(list_tables(&pic, id), vec!["t".to_string()]);
}

// ---------------------------------------------------------------------------
// query: read-only enforcement
// ---------------------------------------------------------------------------

#[test]
fn query_mode_runs_a_select() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();
    execute(&pic, id, "INSERT INTO t VALUES (1), (2)").unwrap();

    let result = query(&pic, id, "SELECT * FROM t").unwrap();
    assert_eq!(result.rows_affected, 2);
}

#[test]
fn query_mode_rejects_a_mutation() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();

    let err = query(&pic, id, "INSERT INTO t VALUES (1)").unwrap_err();
    assert!(
        err.contains("Only SELECT queries are allowed"),
        "unexpected error: {err}"
    );

    // Confirms the rejection actually happened before touching state, not
    // just that the call returned an error string.
    assert_eq!(
        execute(&pic, id, "SELECT * FROM t").unwrap().rows_affected,
        0
    );
}

// ---------------------------------------------------------------------------
// describe_table
// ---------------------------------------------------------------------------

#[test]
fn describe_table_reports_the_schema() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT, name TEXT)").unwrap();
    execute(&pic, id, "INSERT INTO t VALUES (1, 'a')").unwrap();

    #[derive(candid::CandidType, candid::Deserialize, PartialEq, Debug)]
    struct ColumnDef {
        name: String,
        data_type: String,
    }
    #[derive(candid::CandidType, candid::Deserialize, PartialEq, Debug)]
    struct TableDescription {
        name: String,
        columns: Vec<ColumnDef>,
        row_count: u64,
    }
    let (result,): (Result<TableDescription, String>,) =
        query_candid_as(&pic, id, caller(), "describe_table", ("t".to_string(),)).unwrap();
    let description = result.unwrap();
    assert_eq!(description.row_count, 1);
    assert_eq!(description.columns.len(), 2);
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone() {
    let (pic, id) = setup();
    let (doc,): (String,) = query_candid_as(&pic, id, anonymous(), "llm_context", ()).unwrap();
    // Anyone, not just an authenticated/configured caller - it's a
    // description of the canister's own shape, not sensitive data.
    assert!(doc.contains("execute"));
    assert!(doc.contains("ORDER BY"), "must document that ORDER BY/LIMIT are silently ignored, not a real gap to discover the hard way");
}

// ---------------------------------------------------------------------------
// No configuration argument is required. The empty tuple is still encoded
// as Candid because this canister now has a no-argument init hook that opens
// its dynamic config store.
// ---------------------------------------------------------------------------

#[test]
fn installs_with_empty_candid_args_like_the_marketplace_deploy_path() {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister_id = pic.create_canister_with_settings(Some(caller()), None);
    pic.add_cycles(canister_id, 10_000_000_000_000);
    pic.install_canister(
        canister_id,
        IC_SQL_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(caller()),
    );
    execute(&pic, canister_id, "CREATE TABLE t (id INT)").unwrap();
}

// ---------------------------------------------------------------------------
// Upgrade persistence - the one thing the pure engine unit tests can't
// reach: the stable maps must reopen with the same catalog and rows.
// ---------------------------------------------------------------------------

#[test]
fn data_survives_a_canister_upgrade() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT, name TEXT)").unwrap();
    execute(&pic, id, "INSERT INTO t VALUES (1, 'alice'), (2, 'bob')").unwrap();

    pic.upgrade_canister(
        id,
        IC_SQL_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(caller()),
    )
    .expect("upgrade should succeed");

    assert_eq!(list_tables(&pic, id), vec!["t".to_string()]);
    let selected = execute(&pic, id, "SELECT * FROM t").unwrap();
    assert_eq!(selected.rows_affected, 2);

    // The engine's own row-id counter must also have survived - a fresh
    // insert after upgrade shouldn't collide with or reuse existing ids.
    execute(&pic, id, "INSERT INTO t VALUES (3, 'carol')").unwrap();
    let after = execute(&pic, id, "SELECT * FROM t").unwrap();
    assert_eq!(after.rows_affected, 3);
}

// ---------------------------------------------------------------------------
// Auth feature: the two scenarios this module was built for, plus the
// controller gating and upgrade persistence of the permission data itself.
// ---------------------------------------------------------------------------

#[test]
fn a_blocked_user_cannot_execute_or_query() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();
    execute(&pic, id, "INSERT INTO t VALUES (1)").unwrap();

    set_permission(&pic, id, caller(), other_user(), Access::None).unwrap();

    let err = execute_as(&pic, id, other_user(), "INSERT INTO t VALUES (2)").unwrap_err();
    assert!(err.contains("blocked"), "unexpected error: {err}");

    let err = query_as(&pic, id, other_user(), "SELECT * FROM t").unwrap_err();
    assert!(err.contains("blocked"), "unexpected error: {err}");

    // The blocked attempt must not have gone through.
    assert_eq!(
        execute(&pic, id, "SELECT * FROM t").unwrap().rows_affected,
        1
    );
}

#[test]
fn the_anonymous_principal_can_only_read() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();
    execute(&pic, id, "INSERT INTO t VALUES (1)").unwrap();

    // Read access works with no configuration at all.
    let result = query_as(&pic, id, anonymous(), "SELECT * FROM t").unwrap();
    assert_eq!(result.rows_affected, 1);

    // But execute - this canister's read-*write* endpoint - is rejected
    // outright, even though the statement itself is a harmless SELECT.
    let err = execute_as(&pic, id, anonymous(), "SELECT * FROM t").unwrap_err();
    assert!(err.contains("read-only"), "unexpected error: {err}");

    let err = execute_as(&pic, id, anonymous(), "INSERT INTO t VALUES (2)").unwrap_err();
    assert!(err.contains("read-only"), "unexpected error: {err}");
    assert_eq!(
        execute(&pic, id, "SELECT * FROM t").unwrap().rows_affected,
        1
    );
}

#[test]
fn an_explicit_read_only_grant_lets_query_through_but_not_execute() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();

    set_permission(&pic, id, caller(), other_user(), Access::Read).unwrap();

    let result = query_as(&pic, id, other_user(), "SELECT * FROM t").unwrap();
    assert_eq!(result.rows_affected, 0);

    let err = execute_as(&pic, id, other_user(), "INSERT INTO t VALUES (1)").unwrap_err();
    assert!(err.contains("read-only"), "unexpected error: {err}");
}

#[test]
fn set_permission_and_update_config_are_controller_only() {
    let (pic, id) = setup();

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        other_user(),
        "set_permission",
        (PermissionEntry {
            module: "database".to_string(),
            principal: other_user(),
            access: Access::Write,
        },),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("controller"));

    // ACL reads are intentionally public; only mutations are privileged.
    let (access,): (Option<Access>,) = query_candid_as(
        &pic,
        id,
        other_user(),
        "get_permission",
        ("database".to_string(), other_user()),
    )
    .unwrap();
    assert_eq!(access, None);

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        other_user(),
        "update_config",
        (ic_sql::ConfigUpdate::default(),),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("controller"));

    let (result,): (Result<Config, String>,) =
        query_candid_as(&pic, id, other_user(), "get_database_config", ()).unwrap();
    assert!(result.unwrap_err().contains("controller"));
}

#[test]
fn permission_api_is_scoped_to_the_database_module() {
    let (pic, id) = setup();
    let entry = PermissionEntry {
        module: "storage".to_string(),
        principal: other_user(),
        access: Access::Write,
    };
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, id, caller(), "set_permission", (entry,)).unwrap();
    assert!(result.unwrap_err().contains("expected 'database'"));

    let (entries,): (Vec<PermissionEntry>,) = query_candid_as(
        &pic,
        id,
        other_user(),
        "list_permissions",
        (Some("storage".to_string()),),
    )
    .unwrap();
    assert!(entries.is_empty());
}

#[test]
fn remove_permission_reverts_to_the_default() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();

    set_permission(&pic, id, caller(), other_user(), Access::None).unwrap();
    assert!(execute_as(&pic, id, other_user(), "INSERT INTO t VALUES (1)").is_err());

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        caller(),
        "remove_permission",
        ("database".to_string(), other_user()),
    )
    .unwrap();
    result.unwrap();

    // No explicit entry, no auth_canister configured - back to the default
    // read-write access this canister has always had for a real caller.
    execute_as(&pic, id, other_user(), "INSERT INTO t VALUES (1)").unwrap();
}

#[test]
fn permission_data_survives_a_canister_upgrade() {
    let (pic, id) = setup();
    execute(&pic, id, "CREATE TABLE t (id INT)").unwrap();
    set_permission(&pic, id, caller(), other_user(), Access::None).unwrap();

    pic.upgrade_canister(
        id,
        IC_SQL_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(caller()),
    )
    .expect("upgrade should succeed");

    let err = execute_as(&pic, id, other_user(), "INSERT INTO t VALUES (1)").unwrap_err();
    assert!(err.contains("blocked"), "unexpected error: {err}");
}
