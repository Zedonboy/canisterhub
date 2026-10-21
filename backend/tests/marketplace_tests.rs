//! PocketIC integration tests for the `backend` canister: the marketplace
//! (publish/list), the self-declared GitHub repo-publisher registration,
//! and vetKD-backed key access control.
//!
//! Requires a built canister Wasm at
//! `target/wasm32-unknown-unknown/release/backend.wasm` — build it first:
//!
//!   IC_ENV=local cargo build --target wasm32-unknown-unknown --release
//!   IC_ENV=local cargo test
//!
//! Uses the real PocketIC server (not a stub): set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic
//!
//! If unset, the `pocket-ic` crate downloads a matching server version
//! automatically. Deliberately not hardcoded here — a machine-specific path
//! baked into the test source would break for every other environment.

use backend::{MarketplaceItem, MarketplaceItemType};
use candid::{encode_one, Principal};
use ic_vetkeys::types::{AccessRights, ByteBuf};
use ic_vetkeys::TransportSecretKey;
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};

macro_rules! test_info {
    ($($arg:tt)*) => { eprintln!("[INFO] {}", format!($($arg)*)); };
}
macro_rules! test_log {
    ($($arg:tt)*) => { eprintln!("[LOG] {}", format!($($arg)*)); };
}

const BACKEND_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

const TEST_REPO_URL: &str = "https://github.com/alice/cool-project";
const TEST_RELEASE_ASSET_V1: &str =
    "https://github.com/alice/cool-project/releases/download/v1/canister_hub.toml";
const TEST_RELEASE_ASSET_V2: &str =
    "https://github.com/alice/cool-project/releases/download/v2/canister_hub.toml";
const TEST_PACKAGE_SLUG: &str = "cool-project";

/// A placeholder but correctly-sized (32-byte) `wasm_hash` — these tests
/// don't exercise real release artifacts, so the exact digest is
/// irrelevant; only its length matters to `publish_marketplace_item`.
fn fake_wasm_hash() -> Vec<u8> {
    vec![0x42; 32]
}

/// Deterministic, distinct test principals. Not real key-derived identities —
/// PocketIC's `impersonate a sender` calls accept any `Principal`.
fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn admin() -> Principal {
    test_principal(1)
}
fn alice() -> Principal {
    test_principal(2)
}
fn bob() -> Principal {
    test_principal(3)
}
fn mallory() -> Principal {
    test_principal(4)
}

/// A real, validly-encoded (but throwaway) vetKD transport public key — the
/// actual threshold protocol checks this is a well-formed curve point before
/// deriving anything, so an arbitrary byte string (e.g. all-zero) gets
/// rejected outright rather than exercising the authorization logic these
/// tests care about.
fn fake_transport_public_key() -> Vec<u8> {
    let seed: [u8; 32] = rand::random();
    TransportSecretKey::from_seed(seed.to_vec())
        .expect("32-byte seed is valid")
        .public_key()
}

/// Spins up a PocketIC instance with a test-threshold-keys subnet (needed
/// for `test_key_1`, the vetKD key this canister is configured to use — see
/// `VETKD_KEY_NAME` in backend/src/lib.rs) plus an application subnet the
/// canister is actually deployed on, and installs `backend`. `admin()` is
/// the canister's sole controller.
fn setup() -> (PocketIc, Principal) {
    test_info!("starting PocketIC test environment");
    let pic = PocketIcBuilder::new()
        .with_test_threshold_keys_subnet()
        .with_application_subnet()
        .build();

    let backend_id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(
        backend_id,
        BACKEND_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(admin()),
    );
    test_log!("backend installed: canister_id={backend_id}");
    (pic, backend_id)
}

/// Registers `sender` as `repo_url`'s explicit publisher, then publishes as
/// that identity. The registration call is deliberately made by the separate
/// dashboard/admin identity to cover caller/publisher separation.
#[allow(clippy::too_many_arguments)]
fn claim_and_publish(
    pic: &PocketIc,
    backend_id: Principal,
    sender: Principal,
    repo_url: &str,
    release_tag: &str,
    price: Option<u64>,
    encrypted_key: Option<Vec<u8>>,
) -> Result<u64, String> {
    let (register_result,): (Result<(), String>,) = update_candid_as(
        pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (repo_url.to_string(), sender),
    )
    .unwrap();
    register_result.expect("register_repo_publisher should succeed");

    let (result,): (Result<u64, String>,) = update_candid_as(
        pic,
        backend_id,
        sender,
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            repo_url.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            format!("{repo_url}/releases/download/{release_tag}/canister_hub.toml"),
            release_tag.to_string(),
            price,
            encrypted_key,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    result
}

// ---------------------------------------------------------------------------
// Basic sanity
// ---------------------------------------------------------------------------

#[test]
fn greet_returns_a_greeting() {
    let (pic, backend_id) = setup();
    let (greeting,): (String,) = query_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "greet",
        ("world".to_string(),),
    )
    .unwrap();
    assert_eq!(greeting, "Hello, world!");
}

// ---------------------------------------------------------------------------
// register_repo_publisher
// ---------------------------------------------------------------------------

#[test]
fn register_repo_publisher_rejects_anonymous() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), alice()),
    )
    .unwrap();
    assert!(result.is_err());
}

/// Controller-only now (see `register_repo_publisher`'s doc comment): a
/// non-controller authenticated caller - even one who passes an otherwise
/// perfectly valid repo/publisher pair - is rejected outright, not silently
/// re-routed to GitHub-ownership validation it cannot perform. This is the
/// actual security boundary the "Connect Git" flow depends on: only the
/// orchestrator (a controller) may ever create a `REPO_OWNERS` binding.
#[test]
fn register_repo_publisher_rejects_a_non_controller_caller() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), bob()),
    )
    .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("controller"), "got: {err}");
}

#[test]
fn register_repo_publisher_rejects_anonymous_publisher() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), Principal::anonymous()),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn register_repo_publisher_rejects_non_github_url() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        ("https://gitlab.com/alice/cool-project".to_string(), alice()),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn register_repo_publisher_rejects_extra_repository_path_segments() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (
            "https://github.com/alice/cool-project/releases".to_string(),
            alice(),
        ),
    )
    .unwrap();
    assert!(result.is_err());
}

/// The controller (standing in for the orchestrator, post-GitHub-ownership-
/// verification) registers a repo with a publisher principal distinct from
/// anyone involved in the call itself - the normal case, since `publisher`
/// is a separate CI identity, not the GitHub-verified owner's own principal.
#[test]
fn controller_can_register_a_separate_publisher_principal() {
    let (pic, backend_id) = setup();
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), bob()),
    )
    .unwrap();
    result.unwrap();
}

#[test]
fn registering_the_same_repo_again_with_the_same_publisher_is_a_no_op() {
    let (pic, backend_id) = setup();
    for _ in 0..2 {
        let (result,): (Result<(), String>,) = update_candid_as(
            &pic,
            backend_id,
            admin(),
            "register_repo_publisher",
            (TEST_REPO_URL.to_string(), bob()),
        )
        .unwrap();
        result.unwrap();
    }
}

#[test]
fn a_different_publisher_cannot_replace_an_already_registered_publisher() {
    let (pic, backend_id) = setup();
    let (first,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), bob()),
    )
    .unwrap();
    first.unwrap();

    let (second,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), mallory()),
    )
    .unwrap();
    assert!(second.is_err());
}

// ---------------------------------------------------------------------------
// publish_wasm — repo registration
// ---------------------------------------------------------------------------

#[test]
fn publish_wasm_rejects_anonymous() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn publish_wasm_fails_without_being_registered() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("register_repo_publisher"), "got: {err}");
}

#[test]
fn publish_wasm_rejects_an_asset_outside_the_verified_repository() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            "https://evil.example/artifact.wasm.enc".to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("verified repository"));
}

#[test]
fn publish_wasm_free_item_succeeds_once_registered() {
    let (pic, backend_id) = setup();
    let id = claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();

    let (item,): (Option<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "get_marketplace_item", (id,)).unwrap();
    let item = item.expect("item should exist");
    assert_eq!(item.publisher, alice());
    assert_eq!(item.price, None);
    assert_eq!(item.encrypted_key, None);
    assert_eq!(item.git_repo_url, TEST_REPO_URL);
    assert_eq!(item.item_type, MarketplaceItemType::Package);
    assert_eq!(item.download_url, TEST_RELEASE_ASSET_V1);
}

#[test]
fn templates_are_marketplace_items_and_must_be_free() {
    let (pic, backend_id) = setup();
    let (registered,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), alice()),
    )
    .unwrap();
    registered.unwrap();

    let (published,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Template,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "App template".to_string(),
            "Several packages".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            "app-template".to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let id = published.unwrap();
    let (item,): (Option<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "get_marketplace_item", (id,)).unwrap();
    assert_eq!(item.unwrap().item_type, MarketplaceItemType::Template);
}

#[test]
fn republishing_the_same_repo_as_its_owner_does_not_need_reregistering() {
    let (pic, backend_id) = setup();
    let original_id =
        claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();
    let (download_result,): (Result<(), String>,) =
        update_candid_as(&pic, backend_id, alice(), "record_download", (original_id,)).unwrap();
    download_result.unwrap();

    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title v2".to_string(),
            "Description v2".to_string(),
            TEST_RELEASE_ASSET_V2.to_string(),
            "v2".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    assert_eq!(result.unwrap(), original_id);

    let (items,): (Vec<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "list_marketplace_items", ()).unwrap();
    assert_eq!(items.len(), 1, "an update must not create a second listing");
    assert_eq!(items[0].title, "Title v2");
    assert_eq!(items[0].description, "Description v2");
    assert_eq!(items[0].download_url, TEST_RELEASE_ASSET_V2);
    assert_eq!(items[0].downloads, 1, "download count must survive updates");
}

#[test]
fn different_package_slugs_in_the_same_repo_create_independent_items_and_keys() {
    let (pic, backend_id) = setup();
    let first_id =
        claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();

    let second_slug = "analytics";
    let second_manifest =
        "https://github.com/alice/cool-project/releases/download/v1/analytics.canister_hub.toml";
    let (published,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Analytics".to_string(),
            "A second package from this repository".to_string(),
            second_manifest.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            second_slug.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let second_id = published.unwrap();
    assert_ne!(first_id, second_id);

    let (items,): (Vec<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "list_marketplace_items", ()).unwrap();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .any(|item| item.package_slug == TEST_PACKAGE_SLUG));
    assert!(items.iter().any(|item| item.package_slug == second_slug));

    let (first_key,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        alice(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    let (second_key,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        alice(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), second_slug.to_string()),
    )
    .unwrap();
    let first_key = first_key.unwrap();
    let second_key = second_key.unwrap();
    assert_ne!(first_key, second_key);

    let (granted,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(first_key),
            bob(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    granted.unwrap();

    let (second_access,): (Result<ByteBuf, String>,) = update_candid_as(
        &pic,
        backend_id,
        bob(),
        "get_encrypted_vetkey",
        (
            backend_id,
            ByteBuf::from(second_key),
            ByteBuf::from(fake_transport_public_key()),
        ),
    )
    .unwrap();
    assert!(
        second_access.is_err(),
        "access to one package must not unlock another"
    );
}

#[test]
fn publishing_a_different_repo_creates_a_new_marketplace_item() {
    let (pic, backend_id) = setup();
    let first_id =
        claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();
    let second_id = claim_and_publish(
        &pic,
        backend_id,
        alice(),
        "https://github.com/alice/another-project",
        "v1",
        None,
        None,
    )
    .unwrap();

    assert_ne!(first_id, second_id);
    let (items,): (Vec<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "list_marketplace_items", ()).unwrap();
    assert_eq!(items.len(), 2);
}

#[test]
fn a_different_principal_cannot_publish_under_an_already_claimed_repo() {
    let (pic, backend_id) = setup();
    let id = claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();

    // Mallory never registered this repo (and can't - alice already did),
    // so publishing under it must fail, not silently transfer ownership.
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        mallory(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V2.to_string(),
            "v2".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("register_repo_publisher"), "got: {err}");

    let (item,): (Option<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "get_marketplace_item", (id,)).unwrap();
    assert_eq!(item.unwrap().publisher, alice());
}

// ---------------------------------------------------------------------------
// publish_wasm — price / encrypted_key consistency
// ---------------------------------------------------------------------------

#[test]
fn publish_wasm_rejects_a_price_without_an_encrypted_key() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            Some(999_000_000_u64),
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("encrypted_key"), "got: {err}");
}

#[test]
fn publish_wasm_rejects_an_encrypted_key_without_a_price() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            None::<u64>,
            Some(vec![1u8, 2, 3]),
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("price"), "got: {err}");
}

#[test]
fn publish_wasm_paid_item_stores_the_encrypted_key() {
    let (pic, backend_id) = setup();
    let fake_ibe_ciphertext = vec![0xAB; 168]; // shape doesn't matter to the canister — opaque bytes
    let id = claim_and_publish(
        &pic,
        backend_id,
        alice(),
        TEST_REPO_URL,
        "v1",
        Some(499_000_000),
        Some(fake_ibe_ciphertext.clone()),
    )
    .unwrap();

    let (item,): (Option<MarketplaceItem>,) =
        query_candid_as(&pic, backend_id, alice(), "get_marketplace_item", (id,)).unwrap();
    let item = item.unwrap();
    assert_eq!(item.price, Some(499_000_000));
    assert_eq!(item.encrypted_key, Some(fake_ibe_ciphertext));
}

#[test]
fn publish_marketplace_item_rejects_zero_price() {
    let (pic, backend_id) = setup();
    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            Some(0_u64),
            Some(vec![1u8]),
            TEST_PACKAGE_SLUG.to_string(),
            fake_wasm_hash(),
        ),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("greater than zero"));
}

#[test]
fn publish_marketplace_item_rejects_wrong_length_wasm_hash() {
    let (pic, backend_id) = setup();
    let (registered,): (Result<(), String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "register_repo_publisher",
        (TEST_REPO_URL.to_string(), alice()),
    )
    .unwrap();
    registered.unwrap();

    let (result,): (Result<u64, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "publish_marketplace_item",
        (
            MarketplaceItemType::Package,
            None::<String>,
            TEST_REPO_URL.to_string(),
            "Title".to_string(),
            "Description".to_string(),
            TEST_RELEASE_ASSET_V1.to_string(),
            "v1".to_string(),
            None::<u64>,
            None::<Vec<u8>>,
            TEST_PACKAGE_SLUG.to_string(),
            vec![0x42u8; 31], // one byte short of a real sha256 digest
        ),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("wasm_hash"));
}

// ---------------------------------------------------------------------------
// vetKD key access control
// ---------------------------------------------------------------------------

#[test]
fn get_vetkey_verification_key_returns_a_nonempty_key() {
    let (pic, backend_id) = setup();
    let (key,): (ByteBuf,) = update_candid_as(
        &pic,
        backend_id,
        Principal::anonymous(),
        "get_vetkey_verification_key",
        (),
    )
    .unwrap();
    assert!(!key.as_ref().is_empty());
}

#[test]
fn item_key_name_is_deterministic_and_rejects_bad_urls() {
    let (pic, backend_id) = setup();
    let (a,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    let (b,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    assert_eq!(a.unwrap(), b.unwrap());

    let (bad,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        ("not-a-url".to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    assert!(bad.is_err());
}

#[test]
fn controller_cannot_grant_an_unregistered_non_marketplace_key() {
    let (pic, backend_id) = setup();
    let (key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    let (result,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(key_name.unwrap()),
            bob(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn get_encrypted_vetkey_rejects_an_unauthorized_caller() {
    let (pic, backend_id) = setup();
    claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();
    let (key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();

    let (result,): (Result<ByteBuf, String>,) = update_candid_as(
        &pic,
        backend_id,
        bob(),
        "get_encrypted_vetkey",
        (
            backend_id,
            ByteBuf::from(key_name.unwrap()),
            ByteBuf::from(fake_transport_public_key()),
        ),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn controller_can_grant_a_marketplace_key_to_a_buyer() {
    let (pic, backend_id) = setup();
    let item_id = claim_and_publish(
        &pic,
        backend_id,
        alice(),
        TEST_REPO_URL,
        "v1",
        Some(100_000_000),
        Some(vec![0xCD; 32]),
    )
    .unwrap();

    let (not_purchased,): (Result<bool, String>,) = query_candid_as(
        &pic,
        backend_id,
        bob(),
        "has_purchased_marketplace_item",
        (item_id,),
    )
    .unwrap();
    assert_eq!(not_purchased, Ok(false));

    let (key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    let key_name = key_name.unwrap();

    let (grant_result,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        admin(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(key_name.clone()),
            bob(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    grant_result.unwrap();

    let (purchased,): (Result<bool, String>,) = query_candid_as(
        &pic,
        backend_id,
        bob(),
        "has_purchased_marketplace_item",
        (item_id,),
    )
    .unwrap();
    assert_eq!(purchased, Ok(true));

    // A fake-but-correctly-sized (48-byte) BLS transport public key — this
    // canister doesn't validate transport key *correctness* itself (that's
    // the IC subnet's job during the actual vetkd_derive_key protocol); it
    // only gates *authorization* before attempting derivation, which is what
    // this test actually checks.
    let (derive_result,): (Result<ByteBuf, String>,) = update_candid_as(
        &pic,
        backend_id,
        bob(),
        "get_encrypted_vetkey",
        (
            backend_id,
            ByteBuf::from(key_name),
            ByteBuf::from(fake_transport_public_key()),
        ),
    )
    .unwrap();
    assert!(derive_result.is_ok(), "expected Ok, got {derive_result:?}");
}

#[test]
fn non_controller_non_publisher_cannot_grant_access() {
    let (pic, backend_id) = setup();
    claim_and_publish(
        &pic,
        backend_id,
        alice(),
        TEST_REPO_URL,
        "v1",
        Some(100_000_000),
        Some(vec![0xCD; 32]),
    )
    .unwrap();
    let (key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        admin(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();

    let (result,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        mallory(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(key_name.unwrap()),
            bob(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn a_publisher_can_grant_access_to_their_own_items_key() {
    let (pic, backend_id) = setup();
    claim_and_publish(
        &pic,
        backend_id,
        alice(),
        TEST_REPO_URL,
        "v1",
        Some(100_000_000),
        Some(vec![0xCD; 32]),
    )
    .unwrap();

    let (item_key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        alice(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();
    let item_key_name = item_key_name.unwrap();

    // Alice (the verified publisher, not a controller) grants Bob access —
    // this is the real-world "payment confirmed" moment.
    let (grant_result,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        alice(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(item_key_name.clone()),
            bob(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    assert!(grant_result.is_ok(), "expected Ok, got {grant_result:?}");

    let (derive_result,): (Result<ByteBuf, String>,) = update_candid_as(
        &pic,
        backend_id,
        bob(),
        "get_encrypted_vetkey",
        (
            backend_id,
            ByteBuf::from(item_key_name),
            ByteBuf::from(fake_transport_public_key()),
        ),
    )
    .unwrap();
    assert!(derive_result.is_ok(), "expected Ok, got {derive_result:?}");
}

#[test]
fn a_publisher_cannot_grant_access_to_a_different_publishers_item_key() {
    let (pic, backend_id) = setup();
    claim_and_publish(&pic, backend_id, alice(), TEST_REPO_URL, "v1", None, None).unwrap();

    let other_repo = "https://github.com/bob/other-project";
    claim_and_publish(&pic, backend_id, bob(), other_repo, "v1", None, None).unwrap();

    let (alice_item_key_name,): (Result<Vec<u8>, String>,) = query_candid_as(
        &pic,
        backend_id,
        alice(),
        "item_key_name",
        (TEST_REPO_URL.to_string(), TEST_PACKAGE_SLUG.to_string()),
    )
    .unwrap();

    // Bob owns a *different* repo/key, but tries to grant access to Alice's.
    let (result,): (Result<Option<AccessRights>, String>,) = update_candid_as(
        &pic,
        backend_id,
        bob(),
        "set_user_rights",
        (
            backend_id,
            ByteBuf::from(alice_item_key_name.unwrap()),
            mallory(),
            AccessRights::Read,
        ),
    )
    .unwrap();
    assert!(result.is_err());
}
