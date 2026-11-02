use candid::{encode_one, Principal};
use ic_certified_assets::types::{
    AssetCanisterArgs, InitArgs, ListPermittedArguments, Permission, SetPermissions,
};
use pocket_ic::{update_candid_as, PocketIcBuilder};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/assetstorage.wasm"
));

fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

#[test]
fn installer_keeps_manage_permission_when_init_replaces_permission_lists() {
    let installer = principal(1);
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister = pic.create_canister_with_settings(Some(installer), None);

    let args = Some(AssetCanisterArgs::Init(InitArgs {
        set_permissions: Some(SetPermissions {
            prepare: vec![],
            commit: vec![],
            manage_permissions: vec![],
        }),
    }));
    pic.install_canister(
        canister,
        WASM.to_vec(),
        encode_one(args).unwrap(),
        Some(installer),
    );

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
}
