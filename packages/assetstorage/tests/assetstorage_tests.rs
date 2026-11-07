use assetstorage::{ProjectCanister, ProjectContext};
use candid::{encode_args, encode_one, Principal};
use canister_hub_sdk::ic::config::{ConfigValue, ConfigVectorValue};
use ic_certified_assets::types::{ListPermittedArguments, Permission};
use pocket_ic::{query_candid_as, update_candid_as, PocketIcBuilder};
use std::collections::HashMap;
use std::time::Duration;

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/assetstorage.wasm"
));

fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

#[test]
fn dynamic_config_updates_permissions_and_keeps_the_controller_as_manager() {
    let installer = principal(1);
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister = pic.create_canister_with_settings(Some(installer), None);

    pic.install_canister(
        canister,
        WASM.to_vec(),
        encode_one(ProjectContext::default()).unwrap(),
        Some(installer),
    );
    let writer = principal(2);
    let (updated,): (Result<(), String>,) = update_candid_as(
        &pic,
        canister,
        installer,
        "set_config",
        (HashMap::from([(
            "commit_permissions".to_string(),
            ConfigValue::Vector(vec![ConfigVectorValue::PrincipalId(writer)]),
        )]),),
    )
    .unwrap();
    updated.unwrap();

    let (managers,): (Vec<Principal>,) = update_candid_as(
        &pic,
        canister,
        installer,
        "list_permitted",
        (ListPermittedArguments {
            permission: Permission::ManagePermissions,
        },),
    )
    .unwrap();

    assert_eq!(managers, vec![installer]);
    let (committers,): (Vec<Principal>,) = update_candid_as(
        &pic,
        canister,
        installer,
        "list_permitted",
        (ListPermittedArguments {
            permission: Permission::Commit,
        },),
    )
    .unwrap();
    assert_eq!(committers, vec![writer]);
}

#[test]
fn installer_can_read_the_supplied_project_context() {
    let installer = principal(1);
    let related = principal(2);
    let context = ProjectContext {
        project_id: "project-1".to_string(),
        canisters: vec![ProjectCanister {
            canister_id: related,
            package_name: "agent.wasm".to_string(),
        }],
    };
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister = pic.create_canister_with_settings(Some(installer), None);
    pic.install_canister(
        canister,
        WASM.to_vec(),
        encode_one(context.clone()).unwrap(),
        Some(installer),
    );

    let (stored,): (Result<Option<ProjectContext>, String>,) =
        query_candid_as(&pic, canister, installer, "get_project_context", ()).unwrap();
    assert_eq!(stored.unwrap(), Some(context.clone()));

    pic.advance_time(Duration::from_secs(600));
    for _ in 0..100 {
        pic.tick();
    }
    pic.upgrade_canister(
        canister,
        WASM.to_vec(),
        encode_args(()).unwrap(),
        Some(installer),
    )
    .unwrap();
    let (after_upgrade,): (Result<Option<ProjectContext>, String>,) =
        query_candid_as(&pic, canister, installer, "get_project_context", ()).unwrap();
    assert_eq!(after_upgrade.unwrap(), Some(context));
}
