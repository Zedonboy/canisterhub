//! End-to-end tests for the backend's project-scoped notification gateway.

use backend::{CanisterInfo, CanisterKind, PushDelivery, PushNotification};
use candid::{decode_one, encode_args, CandidType, Principal};
use pocket_ic::{PocketIc, PocketIcBuilder};

const BACKEND_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));
fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn update<T: for<'de> candid::Deserialize<'de> + CandidType>(
    pic: &PocketIc,
    canister: Principal,
    sender: Principal,
    method: &str,
    args: impl candid::utils::ArgumentEncoder,
) -> T {
    let reply = pic
        .update_call(canister, sender, method, encode_args(args).unwrap())
        .expect("update call should not reject");
    decode_one(&reply).expect("update response should decode")
}

fn setup() -> (PocketIc, Principal, Principal, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let controller = principal(1);
    let owner = principal(2);

    let backend_id = pic.create_canister_with_settings(Some(controller), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(
        backend_id,
        BACKEND_WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller),
    );

    let package_id = pic.create_canister_with_settings(Some(owner), None);
    let created: Result<(), String> = update(
        &pic,
        backend_id,
        owner,
        "create_project",
        (
            "project-1".to_string(),
            "test".to_string(),
            "local".to_string(),
        ),
    );
    created.unwrap();
    let registered: Result<(), String> = update(
        &pic,
        backend_id,
        owner,
        "add_project_canisters",
        (
            "project-1".to_string(),
            vec![(
                "orders".to_string(),
                CanisterInfo {
                    id: package_id,
                    kind: CanisterKind::Other,
                    package_name: None,
                },
            )],
        ),
    );
    registered.unwrap();

    (pic, backend_id, package_id, owner)
}

fn notification() -> PushNotification {
    PushNotification {
        title: "New order".to_string(),
        body: "Order #42 needs attention".to_string(),
        url: "/orders/42".to_string(),
    }
}

#[test]
fn registered_project_canister_can_notify_project_owner() {
    let (pic, backend_id, package_id, _owner) = setup();
    let result: Result<Vec<PushDelivery>, String> = update(
        &pic,
        backend_id,
        package_id,
        "send_project_notification",
        ("project-1".to_string(), notification()),
    );
    assert_eq!(result.unwrap(), Vec::new());
}

#[test]
fn unregistered_caller_cannot_use_a_project_id() {
    let (pic, backend_id, _package_id, _owner) = setup();
    let result: Result<Vec<PushDelivery>, String> = update(
        &pic,
        backend_id,
        principal(99),
        "send_project_notification",
        ("project-1".to_string(), notification()),
    );
    assert!(result
        .unwrap_err()
        .contains("caller is not a canister registered in this project"));
}
