//! PocketIC integration test for a real `#[dynamic_config]`-annotated
//! canister (`tests/fixtures/example_module`): the generated
//! `get_config_schema`/`get_config`/`set_config` endpoints, controller-only
//! `set_config`, `SecretText` masking for non-controllers, validation
//! errors, and - the one thing no native unit test can reach, since it needs
//! `ic_cdk::api::is_controller`/an actual canister runtime - that the env
//! mirror and stable-stored config both survive a canister upgrade.
//!
//! Requires a built fixture Wasm - build it first:
//!
//!   cd tests/fixtures/example_module
//!   cargo build --target wasm32-unknown-unknown --release
//!
//! Uses the real PocketIC server (not a stub); set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, same as this
//! repo's other PocketIC tests, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic

use candid::{encode_one, Principal};
use canister_hub_sdk::ic::config::{CanisterType, ConfigFieldSchema, ConfigType, ConfigValue};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use std::collections::HashMap;

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/example_module/target/wasm32-unknown-unknown/release/example_module.wasm"
));

fn controller() -> Principal {
    Principal::from_slice(&[7; 10])
}

fn stranger() -> Principal {
    Principal::from_slice(&[8; 10])
}

fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister_id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(canister_id, 10_000_000_000_000);
    pic.install_canister(
        canister_id,
        WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(controller()),
    );
    (pic, canister_id)
}

fn get_config_schema(pic: &PocketIc, id: Principal, caller: Principal) -> Vec<ConfigFieldSchema> {
    let (schema,): (Vec<ConfigFieldSchema>,) =
        query_candid_as(pic, id, caller, "get_config_schema", ()).unwrap();
    schema
}

fn get_config(pic: &PocketIc, id: Principal, caller: Principal) -> HashMap<String, ConfigValue> {
    let (config,): (HashMap<String, ConfigValue>,) =
        query_candid_as(pic, id, caller, "get_config", ()).unwrap();
    config
}

fn set_config(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
    new_settings: HashMap<String, ConfigValue>,
) -> Result<(), String> {
    let (result,): (Result<(), String>,) =
        update_candid_as(pic, id, caller, "set_config", (new_settings,)).unwrap();
    result
}

fn greet(pic: &PocketIc, id: Principal) -> String {
    let (value,): (String,) = query_candid_as(pic, id, controller(), "greet", ()).unwrap();
    value
}

fn feature_enabled(pic: &PocketIc, id: Principal) -> bool {
    let (value,): (bool,) = query_candid_as(pic, id, controller(), "feature_enabled", ()).unwrap();
    value
}

fn get_admin_panel_url(pic: &PocketIc, id: Principal) -> Option<String> {
    let (value,): (Option<String>,) =
        query_candid_as(pic, id, controller(), "get_admin_panel_url", ()).unwrap();
    value
}

fn get_home_page_url(pic: &PocketIc, id: Principal) -> Option<String> {
    let (value,): (Option<String>,) =
        query_candid_as(pic, id, controller(), "get_home_page_url", ()).unwrap();
    value
}

// ---------------------------------------------------------------------------
// get_config_schema
// ---------------------------------------------------------------------------

#[test]
fn schema_reports_every_field_with_its_declared_type_and_requiredness() {
    let (pic, id) = setup();
    let schema = get_config_schema(&pic, id, controller());
    let by_key: HashMap<String, ConfigFieldSchema> = schema
        .into_iter()
        .map(|field| (field.key.clone(), field))
        .collect();

    assert_eq!(by_key.len(), 9);

    let greeting = &by_key["greeting"];
    assert_eq!(greeting.label, "Greeting");
    assert_eq!(greeting.field_type, ConfigType::Text);
    assert!(!greeting.is_required, "has a default, so not required");
    assert_eq!(
        greeting.default_value,
        Some(ConfigValue::Text("Hello!".to_string()))
    );

    let retry_count = &by_key["retry_count"];
    assert_eq!(retry_count.field_type, ConfigType::Number);
    assert!(retry_count.is_required, "no default and not Option<...>");
    assert_eq!(retry_count.default_value, None);

    assert_eq!(by_key["threshold"].field_type, ConfigType::Float);
    assert_eq!(
        by_key["threshold"].default_value,
        Some(ConfigValue::Float(0.5))
    );

    assert_eq!(by_key["feature_enabled"].field_type, ConfigType::Boolean);
    assert_eq!(
        by_key["feature_enabled"].default_value,
        Some(ConfigValue::Boolean(true))
    );

    let api_key = &by_key["api_key"];
    assert_eq!(api_key.field_type, ConfigType::SecretText);
    assert!(!api_key.is_required, "Option<String>");

    let tier = &by_key["tier"];
    assert_eq!(
        tier.field_type,
        ConfigType::Select {
            options: vec!["free".to_string(), "pro".to_string()]
        }
    );
    assert_eq!(
        tier.default_value,
        Some(ConfigValue::Text("free".to_string()))
    );

    let upstream = &by_key["upstream"];
    assert_eq!(
        upstream.field_type,
        ConfigType::CanisterPicker {
            module_type_filter: None
        }
    );
    assert_eq!(upstream.canister_type, None);
    assert_eq!(
        upstream.resolved_canister_type(),
        Some(CanisterType::Custom)
    );
    assert!(!upstream.is_required, "Option<Principal>");

    let auth_canister = &by_key["auth_canister"];
    assert_eq!(
        auth_canister.field_type,
        ConfigType::CanisterPicker {
            module_type_filter: Some("auth".to_string())
        }
    );
    assert_eq!(auth_canister.canister_type, Some(CanisterType::Auth));
    assert!(!auth_canister.is_required, "Option<Principal>");

    let build_hash = &by_key["build_hash"];
    assert_eq!(build_hash.field_type, ConfigType::Text);
    assert_eq!(build_hash.is_readonly, Some(true));
    assert!(
        !build_hash.is_required,
        "read-only values are canister-provided"
    );
}

// ---------------------------------------------------------------------------
// get_config / defaults / env mirror at init
// ---------------------------------------------------------------------------

#[test]
fn get_config_reflects_schema_defaults_right_after_init() {
    let (pic, id) = setup();
    let config = get_config(&pic, id, controller());
    assert_eq!(
        config.get("greeting"),
        Some(&ConfigValue::Text("Hello!".to_string()))
    );
    assert_eq!(
        config.get("tier"),
        Some(&ConfigValue::Text("free".to_string()))
    );
    assert_eq!(
        config.get("feature_enabled"),
        Some(&ConfigValue::Boolean(true))
    );
    // No default and never set.
    assert_eq!(config.get("retry_count"), None);
    assert_eq!(
        config.get("build_hash"),
        Some(&ConfigValue::Text("fixture-build-abc123".to_string()))
    );
}

#[test]
fn init_mirrors_defaults_into_env_for_internal_code() {
    let (pic, id) = setup();
    assert_eq!(greet(&pic, id), "Hello!");
    assert!(feature_enabled(&pic, id));
}

// ---------------------------------------------------------------------------
// set_config: validation
// ---------------------------------------------------------------------------

#[test]
fn set_config_rejects_an_update_missing_a_required_field_with_no_default() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("greeting".to_string(), ConfigValue::Text("Hi".to_string()));
    let err = set_config(&pic, id, controller(), update).unwrap_err();
    assert!(err.contains("retry_count"), "{err}");
}

#[test]
fn set_config_rejects_a_type_mismatch() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(3));
    update.insert(
        "threshold".to_string(),
        ConfigValue::Text("not a float".to_string()),
    );
    let err = set_config(&pic, id, controller(), update).unwrap_err();
    assert!(err.contains("threshold"), "{err}");
}

#[test]
fn set_config_rejects_a_select_value_outside_its_options() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(3));
    update.insert(
        "tier".to_string(),
        ConfigValue::Text("enterprise".to_string()),
    );
    let err = set_config(&pic, id, controller(), update);
    assert!(err.is_err());
}

#[test]
fn set_config_rejects_an_unknown_key() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(3));
    update.insert("nonexistent".to_string(), ConfigValue::Boolean(true));
    let err = set_config(&pic, id, controller(), update).unwrap_err();
    assert!(err.contains("nonexistent"), "{err}");
}

#[test]
fn set_config_rejects_a_readonly_field_even_for_a_controller() {
    let (pic, id) = setup();
    let update = HashMap::from([
        ("retry_count".to_string(), ConfigValue::Number(3)),
        (
            "build_hash".to_string(),
            ConfigValue::Text("spoofed".to_string()),
        ),
    ]);
    let err = set_config(&pic, id, controller(), update).unwrap_err();
    assert!(err.contains("read-only"), "{err}");

    assert_eq!(
        get_config(&pic, id, controller()).get("build_hash"),
        Some(&ConfigValue::Text("fixture-build-abc123".to_string()))
    );
}

#[test]
fn set_config_rejects_a_caller_who_is_not_a_controller() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(3));
    let err = set_config(&pic, id, stranger(), update).unwrap_err();
    assert!(err.contains("controller"), "{err}");
}

// ---------------------------------------------------------------------------
// set_config: success persists, mirrors into env, and is a partial update
// ---------------------------------------------------------------------------

#[test]
fn set_config_persists_and_mirrors_a_valid_update_leaving_other_keys_untouched() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(5));
    update.insert(
        "greeting".to_string(),
        ConfigValue::Text("Howdy".to_string()),
    );
    set_config(&pic, id, controller(), update).unwrap();

    let config = get_config(&pic, id, controller());
    assert_eq!(config.get("retry_count"), Some(&ConfigValue::Number(5)));
    assert_eq!(
        config.get("greeting"),
        Some(&ConfigValue::Text("Howdy".to_string()))
    );
    // Untouched key keeps its prior (default) value.
    assert_eq!(
        config.get("tier"),
        Some(&ConfigValue::Text("free".to_string()))
    );

    assert_eq!(greet(&pic, id), "Howdy");
}

// ---------------------------------------------------------------------------
// SecretText masking
// ---------------------------------------------------------------------------

#[test]
fn secret_text_is_masked_for_non_controllers_but_plain_for_controllers() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(1));
    update.insert(
        "api_key".to_string(),
        ConfigValue::Text("sk-live-secret".to_string()),
    );
    set_config(&pic, id, controller(), update).unwrap();

    let as_controller = get_config(&pic, id, controller());
    assert_eq!(
        as_controller.get("api_key"),
        Some(&ConfigValue::Text("sk-live-secret".to_string()))
    );

    let as_stranger = get_config(&pic, id, stranger());
    assert_ne!(
        as_stranger.get("api_key"),
        Some(&ConfigValue::Text("sk-live-secret".to_string()))
    );
    assert!(matches!(
        as_stranger.get("api_key"),
        Some(ConfigValue::Text(_))
    ));
}

// ---------------------------------------------------------------------------
// get_admin_panel_url / get_home_page_url (#[config_urls(...)])
// ---------------------------------------------------------------------------

#[test]
fn admin_panel_and_home_page_urls_substitute_this_canisters_own_id() {
    let (pic, id) = setup();
    let id_text = id.to_text();
    assert_eq!(
        get_admin_panel_url(&pic, id),
        Some(format!("https://{id_text}.icp0.io/admin"))
    );
    assert_eq!(
        get_home_page_url(&pic, id),
        Some(format!("https://{id_text}.icp0.io/"))
    );
}

// ---------------------------------------------------------------------------
// upgrade survival
// ---------------------------------------------------------------------------

#[test]
fn config_and_env_mirror_survive_a_canister_upgrade() {
    let (pic, id) = setup();
    let mut update = HashMap::new();
    update.insert("retry_count".to_string(), ConfigValue::Number(9));
    update.insert(
        "greeting".to_string(),
        ConfigValue::Text("Persisted".to_string()),
    );
    set_config(&pic, id, controller(), update).unwrap();

    pic.upgrade_canister(
        id,
        WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(controller()),
    )
    .unwrap();

    let config = get_config(&pic, id, controller());
    assert_eq!(config.get("retry_count"), Some(&ConfigValue::Number(9)));
    assert_eq!(
        config.get("greeting"),
        Some(&ConfigValue::Text("Persisted".to_string()))
    );
    // post_upgrade re-mirrors into env, not just the stable cell.
    assert_eq!(greet(&pic, id), "Persisted");
}
