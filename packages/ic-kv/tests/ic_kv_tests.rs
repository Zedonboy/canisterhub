//! PocketIC integration tests for the `ic-kv` canister: `set`/`get`/`delete`/
//! etc. end to end through the real canister interface (not just the pure
//! `engine` unit tests in `src/engine.rs`, which never touch a canister
//! runtime at all), plus - the one thing those unit tests structurally can't
//! reach - that data actually survives a canister upgrade via
//! `pre_upgrade`/`post_upgrade`.
//!
//! Requires a built canister Wasm at
//! `../target/wasm32-unknown-unknown/release/ic_kv.wasm` - build it first:
//!
//!   cargo build --target wasm32-unknown-unknown --release
//!   cargo test
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic

use candid::{encode_one, Principal};
use ic_kv::Value;
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};

fn anonymous() -> Principal {
    Principal::anonymous()
}

const IC_KV_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/ic_kv.wasm"
));

fn caller() -> Principal {
    Principal::from_slice(&[7; 10])
}

fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister_id = pic.create_canister_with_settings(Some(caller()), None);
    pic.add_cycles(canister_id, 10_000_000_000_000);
    pic.install_canister(
        canister_id,
        IC_KV_WASM.to_vec(),
        encode_one(canister_hub_sdk::ProjectContext::default()).unwrap(),
        Some(caller()),
    );
    (pic, canister_id)
}

fn set(pic: &PocketIc, id: Principal, key: &str, value: Value) -> Option<Value> {
    let (old,): (Option<Value>,) =
        update_candid_as(pic, id, caller(), "set", (key.to_string(), value)).unwrap();
    old
}

fn get(pic: &PocketIc, id: Principal, key: &str) -> Option<Value> {
    let (value,): (Option<Value>,) =
        query_candid_as(pic, id, caller(), "get", (key.to_string(),)).unwrap();
    value
}

fn delete(pic: &PocketIc, id: Principal, key: &str) -> Option<Value> {
    let (old,): (Option<Value>,) =
        update_candid_as(pic, id, caller(), "delete", (key.to_string(),)).unwrap();
    old
}

fn exists(pic: &PocketIc, id: Principal, key: &str) -> bool {
    let (result,): (bool,) =
        query_candid_as(pic, id, caller(), "exists", (key.to_string(),)).unwrap();
    result
}

fn keys(pic: &PocketIc, id: Principal, prefix: Option<&str>) -> Vec<String> {
    let (result,): (Vec<String>,) =
        query_candid_as(pic, id, caller(), "keys", (prefix.map(|p| p.to_string()),)).unwrap();
    result
}

fn len(pic: &PocketIc, id: Principal) -> u64 {
    let (result,): (u64,) = query_candid_as(pic, id, caller(), "len", ()).unwrap();
    result
}

// ---------------------------------------------------------------------------
// get/set/delete/exists through the real canister interface
// ---------------------------------------------------------------------------

#[test]
fn set_then_get_round_trips_through_the_canister_interface() {
    let (pic, id) = setup();
    assert_eq!(get(&pic, id, "a"), None);

    let old = set(&pic, id, "a", Value::Text("hello".to_string()));
    assert_eq!(old, None);
    assert_eq!(get(&pic, id, "a"), Some(Value::Text("hello".to_string())));
}

#[test]
fn set_reports_the_previous_value_on_overwrite() {
    let (pic, id) = setup();
    set(&pic, id, "a", Value::Integer(1));
    let old = set(&pic, id, "a", Value::Integer(2));
    assert_eq!(old, Some(Value::Integer(1)));
    assert_eq!(get(&pic, id, "a"), Some(Value::Integer(2)));
}

#[test]
fn delete_removes_the_key_and_exists_reflects_it() {
    let (pic, id) = setup();
    set(&pic, id, "a", Value::Boolean(true));
    assert!(exists(&pic, id, "a"));

    let removed = delete(&pic, id, "a");
    assert_eq!(removed, Some(Value::Boolean(true)));
    assert!(!exists(&pic, id, "a"));
    assert_eq!(get(&pic, id, "a"), None);
}

#[test]
fn keys_lists_sorted_and_can_be_filtered_by_prefix() {
    let (pic, id) = setup();
    set(&pic, id, "user:2", Value::Null);
    set(&pic, id, "user:1", Value::Null);
    set(&pic, id, "order:1", Value::Null);

    assert_eq!(
        keys(&pic, id, None),
        vec![
            "order:1".to_string(),
            "user:1".to_string(),
            "user:2".to_string()
        ]
    );
    assert_eq!(
        keys(&pic, id, Some("user:")),
        vec!["user:1".to_string(), "user:2".to_string()]
    );
    assert_eq!(len(&pic, id), 3);
}

#[test]
fn set_many_and_get_many_round_trip_in_one_call_each() {
    let (pic, id) = setup();
    let entries = vec![
        ("a".to_string(), Value::Integer(1)),
        ("b".to_string(), Value::Integer(2)),
    ];
    let (count,): (u64,) = update_candid_as(&pic, id, caller(), "set_many", (entries,)).unwrap();
    assert_eq!(count, 2);

    let (results,): (Vec<Option<Value>>,) = query_candid_as(
        &pic,
        id,
        caller(),
        "get_many",
        (vec![
            "a".to_string(),
            "missing".to_string(),
            "b".to_string(),
        ],),
    )
    .unwrap();
    assert_eq!(
        results,
        vec![Some(Value::Integer(1)), None, Some(Value::Integer(2))]
    );
}

#[test]
fn clear_empties_the_store_and_reports_how_many_entries_it_held() {
    let (pic, id) = setup();
    set(&pic, id, "a", Value::Null);
    set(&pic, id, "b", Value::Null);

    let (count,): (u64,) = update_candid_as(&pic, id, caller(), "clear", ()).unwrap();
    assert_eq!(count, 2);
    assert_eq!(len(&pic, id), 0);
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone_and_documents_the_api() {
    let (pic, id) = setup();
    let (doc,): (String,) = query_candid_as(&pic, id, anonymous(), "llm_context", ()).unwrap();
    // Anyone, not just an authenticated caller - there's no access control
    // at all in this canister (see the doc itself).
    assert!(doc.contains("set_many"));
    assert!(
        doc.contains("TTL"),
        "must document that there's no expiry, not a real gap to discover the hard way"
    );
}

// ---------------------------------------------------------------------------
// Upgrade persistence - the one thing the pure engine unit tests can't
// reach, since `pre_upgrade`/`post_upgrade` live in `lib.rs`, not `engine.rs`.
// ---------------------------------------------------------------------------

#[test]
fn data_survives_a_canister_upgrade() {
    let (pic, id) = setup();
    set(&pic, id, "a", Value::Text("alice".to_string()));
    set(&pic, id, "b", Value::Bytes(vec![1, 2, 3]));

    pic.upgrade_canister(
        id,
        IC_KV_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(caller()),
    )
    .expect("upgrade should succeed");

    assert_eq!(get(&pic, id, "a"), Some(Value::Text("alice".to_string())));
    assert_eq!(get(&pic, id, "b"), Some(Value::Bytes(vec![1, 2, 3])));
    assert_eq!(len(&pic, id), 2);
}
