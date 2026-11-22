//! Project devices: a device reaches only the projects it was added to, only a
//! project's owner manages its device list, and removal revokes access.

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

fn add_device(pic: &PocketIc, id: Principal, sender: Principal, project: &str, device: Principal) -> Result<Device, String> {
    call(pic, id, sender, "add_project_device", (project.to_string(), device, "laptop".to_string()))
}

fn devices_of(pic: &PocketIc, id: Principal, sender: Principal, project: &str) -> Result<Vec<Device>, String> {
    let reply = pic
        .query_call(id, sender, "list_project_devices", encode_args((project.to_string(),)).unwrap())
        .expect("call should not reject");
    decode_one(&reply).expect("response should decode")
}

#[test]
fn a_device_reaches_only_its_project() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    create_project(&pic, id, owner, "p2");

    let added = add_device(&pic, id, owner, "p1", device).unwrap();
    assert_eq!(added.principal, device);

    let projects: Vec<Project> = call(&pic, id, device, "list_my_projects", ());
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, "p1");
    let got: Option<Project> = call(&pic, id, device, "get_project", ("p1".to_string(),));
    assert!(got.is_some());
    let hidden: Option<Project> = call(&pic, id, device, "get_project", ("p2".to_string(),));
    assert!(hidden.is_none());

    // The device can work on its project but not on the owner's other one.
    let renamed: Result<(), String> =
        call(&pic, id, device, "set_project_name", ("p1".to_string(), "renamed".to_string()));
    renamed.unwrap();
    let denied: Result<(), String> =
        call(&pic, id, device, "set_project_name", ("p2".to_string(), "nope".to_string()));
    assert!(denied.is_err());

    // The owner still owns it, and both sides see the same device list.
    let owned: Vec<Project> = call(&pic, id, owner, "list_my_projects", ());
    assert!(owned.iter().all(|p| p.owner == owner));
    assert_eq!(devices_of(&pic, id, device, "p1").unwrap().len(), 1);
    assert!(devices_of(&pic, id, device, "p2").is_err());
}

#[test]
fn strangers_see_nothing() {
    let (pic, id) = setup();
    create_project(&pic, id, principal(2), "p1");
    let projects: Vec<Project> = call(&pic, id, principal(9), "list_my_projects", ());
    assert!(projects.is_empty());
    assert!(devices_of(&pic, id, principal(9), "p1").is_err());
}

#[test]
fn only_the_owner_manages_a_projects_devices() {
    let (pic, id) = setup();
    let (owner, device, other) = (principal(2), principal(3), principal(4));
    create_project(&pic, id, owner, "p1");
    add_device(&pic, id, owner, "p1", device).unwrap();

    let err = add_device(&pic, id, device, "p1", other).unwrap_err();
    assert!(err.contains("no project"), "{err}");
    let err = add_device(&pic, id, other, "p1", other).unwrap_err();
    assert!(err.contains("no project"), "{err}");

    let removed: Result<(), String> = call(&pic, id, other, "remove_project_device", ("p1".to_string(), device));
    assert!(removed.is_err());
    let removed: Result<(), String> = call(&pic, id, device, "remove_project_device", ("p1".to_string(), device));
    assert!(removed.is_err());

    let anon = add_device(&pic, id, Principal::anonymous(), "p1", other);
    assert!(anon.is_err());
}

#[test]
fn a_device_cannot_delete_the_project() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    add_device(&pic, id, owner, "p1", device).unwrap();
    let denied: Result<(), String> = call(&pic, id, device, "delete_project", ("p1".to_string(),));
    assert!(denied.is_err());
    let deleted: Result<(), String> = call(&pic, id, owner, "delete_project", ("p1".to_string(),));
    deleted.unwrap();
}

#[test]
fn invalid_devices_are_rejected() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    assert!(add_device(&pic, id, owner, "p1", owner).unwrap_err().contains("already the owner"));
    assert!(add_device(&pic, id, owner, "p1", Principal::anonymous()).unwrap_err().contains("anonymous"));
    add_device(&pic, id, owner, "p1", device).unwrap();
    assert!(add_device(&pic, id, owner, "p1", device).unwrap_err().contains("already a device"));

    let empty: Result<Device, String> = call(
        &pic,
        id,
        owner,
        "add_project_device",
        ("p1".to_string(), principal(6), "  ".to_string()),
    );
    assert!(empty.unwrap_err().contains("label"));
}

#[test]
fn the_same_principal_can_be_a_device_of_several_projects() {
    let (pic, id) = setup();
    let (owner, other_owner, device) = (principal(2), principal(4), principal(3));
    create_project(&pic, id, owner, "p1");
    create_project(&pic, id, other_owner, "p2");
    add_device(&pic, id, owner, "p1", device).unwrap();
    add_device(&pic, id, other_owner, "p2", device).unwrap();
    let projects: Vec<Project> = call(&pic, id, device, "list_my_projects", ());
    assert_eq!(projects.len(), 2);
}

#[test]
fn removing_a_device_revokes_access() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    add_device(&pic, id, owner, "p1", device).unwrap();

    let removed: Result<(), String> = call(&pic, id, owner, "remove_project_device", ("p1".to_string(), device));
    removed.unwrap();
    let projects: Vec<Project> = call(&pic, id, device, "list_my_projects", ());
    assert!(projects.is_empty());
}

#[test]
fn deleting_a_project_drops_its_devices() {
    let (pic, id) = setup();
    let (owner, device) = (principal(2), principal(3));
    create_project(&pic, id, owner, "p1");
    add_device(&pic, id, owner, "p1", device).unwrap();
    let deleted: Result<(), String> = call(&pic, id, owner, "delete_project", ("p1".to_string(),));
    deleted.unwrap();
    // A new project reusing the id must not inherit the old device.
    create_project(&pic, id, owner, "p1");
    assert!(devices_of(&pic, id, owner, "p1").unwrap().is_empty());
}

#[test]
fn device_count_is_capped() {
    let (pic, id) = setup();
    let owner = principal(2);
    create_project(&pic, id, owner, "p1");
    for byte in 10..20 {
        add_device(&pic, id, owner, "p1", principal(byte)).unwrap();
    }
    assert!(add_device(&pic, id, owner, "p1", principal(30)).unwrap_err().contains("at most 10"));
}
