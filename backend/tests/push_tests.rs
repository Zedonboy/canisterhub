//! PocketIC integration tests for `backend`'s Web Push persistence surface
//! (`push_subscribe`/`push_unsubscribe`/`push_list_subscriptions` in
//! `backend/src/lib.rs`): `backend` is a pure persistence layer here - the
//! orchestrator owns VAPID keys, HTTP routes, and JWT auth
//! (`services/orchestrator/src/push.rs`), and calls these three
//! controller-gated methods on a user's behalf after verifying their JWT
//! itself. See `marketplace_tests.rs::register_repo_publisher` tests for
//! the same controller-gating pattern.
//!
//! Requires a built canister Wasm at
//! `target/wasm32-unknown-unknown/release/backend.wasm` — build it first:
//!
//!   IC_ENV=local cargo build --target wasm32-unknown-unknown --release
//!   IC_ENV=local cargo test

use backend::PushSubscription;
use candid::Principal;
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};

const BACKEND_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

/// Stands in for the orchestrator - the canister's own controller (installer).
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
    let backend_id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(backend_id, BACKEND_WASM.to_vec(), candid::encode_one(()).unwrap(), Some(controller()));
    (pic, backend_id)
}

fn sample_subscription(tag: &str) -> PushSubscription {
    PushSubscription {
        endpoint: format!("https://push.example/{tag}"),
        p256dh: "k".to_string(),
        auth: "a".to_string(),
    }
}

#[test]
fn push_subscribe_is_controller_gated() {
    let (pic, backend_id) = setup();
    // `alice` calling on her own behalf (not the orchestrator/controller) is
    // rejected - only the orchestrator may prove which principal a real
    // subscribe request came from.
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "push_subscribe",
        (alice(), sample_subscription("ep-1")),
    )
    .unwrap();
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("controller"));
}

#[test]
fn controller_can_subscribe_then_list_then_unsubscribe_on_a_user_s_behalf() {
    let (pic, backend_id) = setup();

    let (subscribe_result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_subscribe",
        (alice(), sample_subscription("ep-1")),
    )
    .unwrap();
    assert_eq!(subscribe_result, Ok(()));

    let (listed,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(&pic, backend_id, controller(), "push_list_subscriptions", (alice(),)).unwrap();
    let listed = listed.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].endpoint, "https://push.example/ep-1");

    let (unsubscribe_result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_unsubscribe",
        (alice(), "https://push.example/ep-1".to_string()),
    )
    .unwrap();
    assert_eq!(unsubscribe_result, Ok(()));

    let (after,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(&pic, backend_id, controller(), "push_list_subscriptions", (alice(),)).unwrap();
    assert!(after.unwrap().is_empty());
}

#[test]
fn resubscribing_the_same_endpoint_updates_in_place_instead_of_duplicating() {
    let (pic, backend_id) = setup();

    for auth_secret in ["first-auth", "second-auth"] {
        let mut subscription = sample_subscription("ep-dup");
        subscription.auth = auth_secret.to_string();
        let (result,): (Result<(), String>,) =
            update_candid_as(&pic, backend_id, controller(), "push_subscribe", (alice(), subscription)).unwrap();
        assert_eq!(result, Ok(()));
    }

    let (listed,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(&pic, backend_id, controller(), "push_list_subscriptions", (alice(),)).unwrap();
    let listed = listed.unwrap();
    assert_eq!(listed.len(), 1, "re-subscribing the same endpoint must not duplicate: {listed:?}");
    assert_eq!(listed[0].auth, "second-auth");
}

#[test]
fn two_principals_subscriptions_are_kept_separate() {
    let (pic, backend_id) = setup();

    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_subscribe",
        (alice(), sample_subscription("alice-ep")),
    )
    .unwrap();
    assert_eq!(result, Ok(()));

    let (bobs_list,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(&pic, backend_id, controller(), "push_list_subscriptions", (bob(),)).unwrap();
    assert!(bobs_list.unwrap().is_empty(), "bob must not see alice's subscription");
}

#[test]
fn push_subscribe_rejects_the_anonymous_principal() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_subscribe",
        (Principal::anonymous(), sample_subscription("ep-1")),
    )
    .unwrap();
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("anonymous"));
}

#[test]
fn unsubscribing_a_non_existent_endpoint_is_not_an_error() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        controller(),
        "push_unsubscribe",
        (alice(), "https://push.example/never-subscribed".to_string()),
    )
    .unwrap();
    assert_eq!(result, Ok(()));
}

#[test]
fn push_list_subscriptions_is_controller_gated() {
    let (pic, backend_id) = setup();
    let (result,): (Result<Vec<PushSubscription>, String>,) =
        query_candid_as(&pic, backend_id, alice(), "push_list_subscriptions", (alice(),)).unwrap();
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("controller"));
}
