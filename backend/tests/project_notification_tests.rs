//! End-to-end tests for the backend's project-scoped notification gateway.

use backend::{CanisterInfo, CanisterKind, PushDelivery, PushNotification, PushSubscription};
use candid::{decode_one, encode_args, CandidType, Principal};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
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

#[test]
fn authenticated_user_can_send_test_to_own_subscriptions() {
    let (pic, backend_id, _package_id, owner) = setup();
    let result: Result<Vec<PushDelivery>, String> = update(
        &pic,
        backend_id,
        owner,
        "push_send",
        (owner, notification()),
    );
    assert_eq!(result.unwrap(), Vec::new());
}

#[test]
fn user_cannot_send_test_to_another_principal() {
    let (pic, backend_id, _package_id, owner) = setup();
    let result: Result<Vec<PushDelivery>, String> = update(
        &pic,
        backend_id,
        owner,
        "push_send",
        (principal(99), notification()),
    );
    assert!(result
        .unwrap_err()
        .contains("notification recipient must match the authenticated caller"));
}

#[test]
fn anonymous_user_cannot_send_test_push() {
    let (pic, backend_id, _package_id, _owner) = setup();
    let result: Result<Vec<PushDelivery>, String> = update(
        &pic,
        backend_id,
        Principal::anonymous(),
        "push_send",
        (Principal::anonymous(), notification()),
    );
    assert!(result
        .unwrap_err()
        .contains("anonymous callers may not send test push notifications"));
}

fn subscribe_owner(pic: &PocketIc, backend_id: Principal, owner: Principal) {
    let vapid: Result<Vec<u8>, String> = update(pic, backend_id, owner, "push_ensure_vapid", ());
    vapid.unwrap();
    let secret = p256::SecretKey::random(&mut rand::thread_rng());
    let subscription = PushSubscription {
        endpoint: "https://push.example/send/1".to_string(),
        p256dh: URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes()),
        auth: URL_SAFE_NO_PAD.encode([7u8; 16]),
    };
    let subscribed: Result<(), String> =
        update(pic, backend_id, owner, "push_subscribe", (owner, subscription));
    subscribed.unwrap();
}

/// Submits `push_send`, answers the single push-service outcall with `status`,
/// and returns the call's result.
fn push_send_with_push_service_status(
    pic: &PocketIc,
    backend_id: Principal,
    owner: Principal,
    status: u16,
) -> Result<Vec<PushDelivery>, String> {
    let call_id = pic
        .submit_call(
            backend_id,
            owner,
            "push_send",
            encode_args((owner, notification())).unwrap(),
        )
        .unwrap();
    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    if requests.is_empty() {
        // Rejected before any outcall (e.g. cooldown).
        return decode_one(&pic.await_call(call_id).unwrap()).unwrap();
    }
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: requests[0].subnet_id,
        request_id: requests[0].request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status,
            headers: vec![],
            body: vec![],
        }),
        additional_responses: vec![],
    });
    decode_one(&pic.await_call(call_id).unwrap()).unwrap()
}

#[test]
fn test_push_is_limited_to_one_success_per_24_hours() {
    let (pic, backend_id, _package_id, owner) = setup();
    subscribe_owner(&pic, backend_id, owner);

    // A push-service error does not start the cooldown, so it can be retried.
    let failed = push_send_with_push_service_status(&pic, backend_id, owner, 500).unwrap();
    assert_eq!(failed[0].status, Some(500));

    let sent = push_send_with_push_service_status(&pic, backend_id, owner, 201).unwrap();
    assert_eq!(sent[0].status, Some(201));

    // Now rate limited, with no outcall made.
    let limited = push_send_with_push_service_status(&pic, backend_id, owner, 201);
    assert!(limited.unwrap_err().contains("try again in about 24 hour"));

    pic.advance_time(std::time::Duration::from_secs(23 * 3600));
    pic.tick();
    let still_limited = push_send_with_push_service_status(&pic, backend_id, owner, 201);
    assert!(still_limited.unwrap_err().contains("try again in about 1 hour"));

    pic.advance_time(std::time::Duration::from_secs(3600 + 1));
    pic.tick();
    let again = push_send_with_push_service_status(&pic, backend_id, owner, 201).unwrap();
    assert_eq!(again[0].status, Some(201));
}
