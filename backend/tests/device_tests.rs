//! Co-owner devices: a device acts as its owner for project access, only the
//! owner manages the device list, and removal revokes access.

use backend::{Device, Project};
use candid::{decode_one, encode_args, CandidType, Principal};
use pocket_ic::{PocketIc, PocketIcBuilder};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn call<T: for<'de> candid::Deserialize<'de> + CandidType>(
    pic: &PocketIc,
    id: Principal,
    sender: Principal,
    method: &str,
    args: impl candid::utils::ArgumentEncoder,
) -> T {
    let reply = pic
        .update_call(id, sender, method, encode_args(args).unwrap())
        .expect("call should not reject");
    decode_one(&reply).expect("response should decode")
}

fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(principal(1)), None);
    pic.add_cycles(id, 30_000_000_000_000);
    pic.install_canister(id, WASM.to_vec(), candid::encode_one(()).unwrap(), Some(principal(1)));
    (pic, id)
}

fn create_project(pic: &PocketIc, id: Principal, sender: Principal, name: &str) {
    let r: Result<(), String> = call(
        pic,
        id,
        sender,
        "create_project",
        (name.to_string(), "req".to_string(), "local".to_string()),
    );
    r.unwrap();
}

fn add_device(pic: &PocketIc, id: Principal, sender: Principal, device: Principal) -> Result<Device, String> {
    call(pic, id, sender, "add_device", (device, "laptop".to_string()))
}

#[test]
fn a_device_acts_as_its_owner() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");

    let added = add_device(&pic, id, owner, device).unwrap();
    assert_eq!(added.principal, device);

    let projects: Vec<Project> = call(&pic, id, device, "list_my_projects", ());
    assert_eq!(projects.len(), 1);
    let got: Option<Project> = call(&pic, id, device, "get_project", ("p1".to_string(),));
    assert!(got.is_some());
    let resolved: Principal = call(&pic, id, device, "my_owner", ());
    assert_eq!(resolved, owner);

    // Projects created from the device belong to the owner.
    create_project(&pic, id, device, "p2");
    let owned: Vec<Project> = call(&pic, id, owner, "list_my_projects", ());
    assert_eq!(owned.len(), 2);
    assert!(owned.iter().all(|p| p.owner == owner));

    // Both sides see the same device list.
    let from_device: Vec<Device> = call(&pic, id, device, "list_devices", ());
    assert_eq!(from_device.len(), 1);
}

#[test]
fn strangers_see_nothing() {
    let (pic, id) = setup();
    create_project(&pic, id, principal(2), "p1");
    let projects: Vec<Project> = call(&pic, id, principal(9), "list_my_projects", ());
    assert!(projects.is_empty());
}

#[test]
fn only_the_owner_manages_devices() {
    let (pic, id) = setup();
    let (owner, device, other) = (principal(2), principal(3), principal(4));
    add_device(&pic, id, owner, device).unwrap();

    let err = add_device(&pic, id, device, other).unwrap_err();
    assert!(err.contains("only the owner may add devices"), "{err}");

    let removed: Result<(), String> = call(&pic, id, other, "remove_device", (device,));
    assert!(removed.unwrap_err().contains("not one of your devices"));
    let removed: Result<(), String> = call(&pic, id, device, "remove_device", (device,));
    assert!(removed.is_err());

    let anon = add_device(&pic, id, Principal::anonymous(), other);
    assert!(anon.unwrap_err().contains("anonymous"));
}

#[test]
fn invalid_devices_are_rejected() {
    let (pic, id) = setup();
    let (owner, device, other) = (principal(2), principal(3), principal(4));
    assert!(add_device(&pic, id, owner, owner).unwrap_err().contains("already the owner"));
    assert!(add_device(&pic, id, owner, Principal::anonymous()).unwrap_err().contains("anonymous"));
    add_device(&pic, id, owner, device).unwrap();
    assert!(add_device(&pic, id, owner, device).unwrap_err().contains("already a device"));
    // Another owner cannot claim an existing device.
    assert!(add_device(&pic, id, other, device).unwrap_err().contains("already a device"));

    // A principal with projects of its own would lose sight of them.
    create_project(&pic, id, principal(5), "mine");
    assert!(add_device(&pic, id, owner, principal(5)).unwrap_err().contains("already owns projects"));

    // An owner that has devices cannot itself become a device.
    assert!(add_device(&pic, id, other, owner).unwrap_err().contains("already has devices"));

    let empty: Result<Device, String> =
        call(&pic, id, owner, "add_device", (principal(6), "  ".to_string()));
    assert!(empty.unwrap_err().contains("label"));
}

#[test]
fn removing_a_device_revokes_access() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    add_device(&pic, id, owner, device).unwrap();

    let removed: Result<(), String> = call(&pic, id, owner, "remove_device", (device,));
    removed.unwrap();
    let projects: Vec<Project> = call(&pic, id, device, "list_my_projects", ());
    assert!(projects.is_empty());
    let resolved: Principal = call(&pic, id, device, "my_owner", ());
    assert_eq!(resolved, device);
}

#[test]
fn device_count_is_capped() {
    let (pic, id) = setup();
    let owner = principal(2);
    for byte in 10..20 {
        add_device(&pic, id, owner, principal(byte)).unwrap();
    }
    assert!(add_device(&pic, id, owner, principal(30)).unwrap_err().contains("at most 10"));
}
