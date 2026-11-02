//! PocketIC integration tests for module-owned Web Push configuration and
//! caller-scoped subscription persistence.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::Principal;
use canister_hub_sdk::ic::config::{ConfigValue, ConfigVectorValue};
use notification::{PushNotification, PushSubscription};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use std::collections::HashMap;

const NOTIFICATION_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/notification.wasm"
));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn controller() -> Principal {
    test_principal(1)
}

fn alice() -> Principal {
    test_principal(2)
}

fn bob() -> Principal {
    test_principal(3)
}

fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let notification_id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(notification_id, 30_000_000_000_000);
    pic.install_canister(
        notification_id,
        NOTIFICATION_WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller()),
    );
    (pic, notification_id)
}

fn sample_subscription(tag: &str, auth_byte: u8) -> PushSubscription {
    let secret = SecretKey::from_slice(&[9; 32]).unwrap();
    PushSubscription {
        endpoint: format!("https://push.example/{tag}"),
        p256dh: URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes()),
        auth: URL_SAFE_NO_PAD.encode([auth_byte; 16]),
    }
}

fn list(
    pic: &PocketIc,
    backend_id: Principal,
    caller: Principal,
) -> Result<Vec<PushSubscription>, String> {
    let (result,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(pic, backend_id, caller, "push_list_subscriptions", ()).unwrap();
    result
}

#[test]
fn authenticated_user_can_subscribe_list_and_unsubscribe_directly() {
    let (pic, backend_id) = setup();
    let subscription = sample_subscription("ep-1", 1);
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_subscribe",
        (subscription.clone(),),
    )
    .unwrap();
    assert_eq!(result, Ok(()));
    assert_eq!(
        list(&pic, backend_id, alice()).unwrap(),
        vec![subscription.clone()]
    );

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_unsubscribe",
        (subscription.endpoint,),
    )
    .unwrap();
    assert_eq!(result, Ok(()));
    assert!(list(&pic, backend_id, alice()).unwrap().is_empty());
}

#[test]
fn subscriptions_are_scoped_to_msg_caller() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_subscribe",
        (sample_subscription("alice", 2),),
    )
    .unwrap();
    assert_eq!(result, Ok(()));
    assert!(list(&pic, backend_id, bob()).unwrap().is_empty());
}

#[test]
fn resubscribing_an_endpoint_updates_keys_without_duplication() {
    let (pic, backend_id) = setup();
    for auth_byte in [3, 4] {
        let (result,): (Result<(), String>,) = update_candid_as(
            &pic,
            backend_id,
            alice(),
            "push_subscribe",
            (sample_subscription("same", auth_byte),),
        )
        .unwrap();
        assert_eq!(result, Ok(()));
    }
    let subscriptions = list(&pic, backend_id, alice()).unwrap();
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions[0].auth, URL_SAFE_NO_PAD.encode([4; 16]));
}

#[test]
fn anonymous_and_malformed_subscriptions_are_rejected() {
    let (pic, backend_id) = setup();
    let (anonymous,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "push_subscribe",
        (sample_subscription("anonymous", 5),),
    )
    .unwrap();
    assert!(anonymous.unwrap_err().contains("anonymous"));

    let mut malformed = sample_subscription("bad", 6);
    malformed.p256dh = "not-a-key".to_string();
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, backend_id, alice(), "push_subscribe", (malformed,)).unwrap();
    assert!(result.is_err());
}

#[test]
fn only_controller_can_initialize_vapid_and_public_key_is_readable() {
    let (pic, backend_id) = setup();
    let (denied,): (Result<Vec<u8>, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_init_vapid",
        ("mailto:ops@example.com",),
    )
    .unwrap();
    assert!(denied.unwrap_err().contains("controller"));

    let (generated,): (Result<Vec<u8>, String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_init_vapid",
        ("mailto:ops@example.com",),
    )
    .unwrap();
    let generated = generated.unwrap();
    assert_eq!(generated.len(), 65);

    let (public,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "push_vapid_public_key",
        (),
    )
    .unwrap();
    assert_eq!(public.unwrap(), generated);
}

#[test]
fn sending_is_limited_to_controllers_and_trusted_senders() {
    let (pic, backend_id) = setup();
    let notification = PushNotification {
        title: "Hello".to_string(),
        body: "World".to_string(),
        url: "/project/1".to_string(),
    };
    let (denied,): (Result<Vec<notification::PushDelivery>, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_send",
        (alice(), notification.clone()),
    )
    .unwrap();
    assert!(denied.unwrap_err().contains("trusted sender"));

    let settings = HashMap::from([(
        "trusted_senders".to_string(),
        ConfigValue::Vector(vec![ConfigVectorValue::PrincipalId(alice())]),
    )]);
    let (configured,): (Result<(), String>,) =
        update_candid_as(&pic, backend_id, controller(), "set_config", (settings,)).unwrap();
    configured.unwrap();

    let (initialized,): (Result<Vec<u8>, String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_init_vapid",
        ("mailto:ops@example.com",),
    )
    .unwrap();
    initialized.unwrap();

    let (sent,): (Result<Vec<notification::PushDelivery>, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_send",
        (alice(), notification),
    )
    .unwrap();
    assert!(sent.unwrap().is_empty());
}

#[test]
fn vapid_identity_and_subscriptions_survive_upgrade() {
    let (pic, canister_id) = setup();
    let subscription = sample_subscription("upgrade", 9);
    let (subscribed,): (Result<(), String>,) = update_candid_as(
        &pic,
        canister_id,
        alice(),
        "push_subscribe",
        (subscription.clone(),),
    )
    .unwrap();
    subscribed.unwrap();
    let (generated,): (Result<Vec<u8>, String>,) = update_candid_as(
        &pic,
        canister_id,
        controller(),
        "push_init_vapid",
        ("mailto:ops@example.com",),
    )
    .unwrap();
    let generated = generated.unwrap();

    pic.upgrade_canister(
        canister_id,
        NOTIFICATION_WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller()),
    )
    .unwrap();

    let (public,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        canister_id,
        Principal::anonymous(),
        "push_vapid_public_key",
        (),
    )
    .unwrap();
    assert_eq!(public.unwrap(), generated);
    assert_eq!(
        list(&pic, canister_id, alice()).unwrap(),
        vec![subscription]
    );
}
