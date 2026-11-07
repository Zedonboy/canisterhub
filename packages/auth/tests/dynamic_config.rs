use auth::ConfigUpdate;
use candid::{encode_one, Principal};
use canister_hub_sdk::ic::config::{ConfigFieldSchema, ConfigValue};
use pocket_ic::{query_candid_as, update_candid_as, PocketIcBuilder};
use std::collections::HashMap;

const AUTH_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/auth.wasm"
));

fn controller() -> Principal {
    Principal::from_slice(&[7; 10])
}

#[test]
fn runtime_config_is_available_after_empty_install_and_survives_upgrade() {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(id, 10_000_000_000_000);
    pic.install_canister(
        id,
        AUTH_WASM.to_vec(),
        encode_one(canister_hub_sdk::ProjectContext::default()).unwrap(),
        Some(controller()),
    );

    let (schema,): (Vec<ConfigFieldSchema>,) =
        query_candid_as(&pic, id, controller(), "get_config_schema", ()).unwrap();
    assert_eq!(
        schema
            .iter()
            .map(|field| field.key.as_str())
            .collect::<Vec<_>>(),
        vec!["session_ttl_secs", "frontend_redirect_url"]
    );

    let settings = HashMap::from([
        ("session_ttl_secs".to_string(), ConfigValue::Number(7200)),
        (
            "frontend_redirect_url".to_string(),
            ConfigValue::Text("https://example.com/auth/callback".to_string()),
        ),
    ]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, id, controller(), "set_config", (settings,)).unwrap();
    result.unwrap();

    pic.upgrade_canister(
        id,
        AUTH_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(controller()),
    )
    .unwrap();

    let (config,): (HashMap<String, ConfigValue>,) =
        query_candid_as(&pic, id, controller(), "get_config", ()).unwrap();
    assert_eq!(config["session_ttl_secs"], ConfigValue::Number(7200));
    assert_eq!(
        config["frontend_redirect_url"],
        ConfigValue::Text("https://example.com/auth/callback".to_string())
    );

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        controller(),
        "update_config",
        (ConfigUpdate {
            frontend_redirect_url: Some(None),
            ..Default::default()
        },),
    )
    .unwrap();
    result.unwrap();
    let (config,): (HashMap<String, ConfigValue>,) =
        query_candid_as(&pic, id, controller(), "get_config", ()).unwrap();
    assert!(!config.contains_key("frontend_redirect_url"));
}
