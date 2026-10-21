//! PocketIC integration tests for `backend`'s project-tracking surface (see
//! the "Project tracking" section of `backend/src/lib.rs`): the frontend, as
//! the real signed-in user, writes and reads project state here directly -
//! every method is owner-gated, none of them involve the orchestrator at all
//! (see the `decouple-orchestrator-api` project notes).
//!
//! Requires a built canister Wasm at
//! `target/wasm32-unknown-unknown/release/backend.wasm` — build it first:
//!
//!   IC_ENV=local cargo build --target wasm32-unknown-unknown --release
//!   IC_ENV=local cargo test
//!
//! Uses the real PocketIC server (not a stub) — see `marketplace_tests.rs`'s
//! own header comment for the `POCKET_IC_BIN` note, which applies here too.

use backend::{CanisterInfo, CanisterKind, Project, ProjectState};
use candid::{decode_one, encode_args, Principal};
use pocket_ic::{PocketIc, PocketIcBuilder};

const BACKEND_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

/// Deterministic, distinct test principals — same convention as
/// `marketplace_tests.rs::test_principal`.
fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

/// Stands in for the canister's own controller (installer) - distinct from
/// any project owner below, to make sure controller status alone grants no
/// special access to any `Project` (every method here is owner-gated only).
fn controller() -> Principal {
    test_principal(1)
}
/// Stands in for a real end-user's Internet-Identity principal - creates
/// and owns its own projects directly.
fn alice() -> Principal {
    test_principal(2)
}
fn bob() -> Principal {
    test_principal(3)
}

/// Spins up a plain PocketIC application-subnet instance with `backend`
/// installed. No threshold-keys subnet needed here (unlike
/// `marketplace_tests.rs::setup`) — none of the project-tracking methods
/// touch vetKD.
fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let backend_id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(
        backend_id,
        BACKEND_WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller()),
    );
    (pic, backend_id)
}

fn call<T: for<'de> candid::Deserialize<'de> + candid::CandidType>(
    pic: &PocketIc,
    backend_id: Principal,
    sender: Principal,
    method: &str,
    args: impl candid::utils::ArgumentEncoder,
) -> T {
    let payload = encode_args(args).unwrap();
    let reply = pic
        .update_call(backend_id, sender, method, payload)
        .expect("call should not be rejected");
    decode_one(&reply).expect("failed to decode reply")
}

fn query<T: for<'de> candid::Deserialize<'de> + candid::CandidType>(
    pic: &PocketIc,
    backend_id: Principal,
    sender: Principal,
    method: &str,
    args: impl candid::utils::ArgumentEncoder,
) -> T {
    let payload = encode_args(args).unwrap();
    let reply = pic
        .query_call(backend_id, sender, method, payload)
        .expect("query should not be rejected");
    decode_one(&reply).expect("failed to decode reply")
}

fn connector_id() -> CanisterInfo {
    CanisterInfo {
        id: test_principal(50),
        kind: CanisterKind::Connector,
    }
}
fn database_id() -> CanisterInfo {
    CanisterInfo {
        id: test_principal(51),
        kind: CanisterKind::Database,
    }
}

#[test]
fn create_project_makes_the_caller_its_owner() {
    let (pic, backend_id) = setup();
    let created: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        (
            "p1".to_string(),
            "build me an app".to_string(),
            "local".to_string(),
        ),
    );
    created.expect("any caller should be able to create their own project");

    let as_owner: Option<Project> = query(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    );
    let project = as_owner.expect("alice should be able to read her own project");
    assert_eq!(project.id, "p1");
    assert_eq!(project.request, "build me an app");
    assert_eq!(project.network, "local");
    assert_eq!(
        project.owner,
        alice(),
        "the caller becomes the owner directly"
    );
    assert_eq!(project.state, ProjectState::Running);
    assert!(project.canisters.is_empty());

    let as_non_owner: Option<Project> =
        query(&pic, backend_id, bob(), "get_project", ("p1".to_string(),));
    assert!(
        as_non_owner.is_none(),
        "bob must not be able to read alice's project"
    );

    let missing: Option<Project> = query(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("no-such-id".to_string(),),
    );
    assert!(missing.is_none());
}

#[test]
fn anonymous_cannot_create_a_shared_project() {
    let (pic, backend_id) = setup();
    let result: Result<(), String> = call(
        &pic,
        backend_id,
        Principal::anonymous(),
        "create_project",
        (
            "anonymous".to_string(),
            "req".to_string(),
            "local".to_string(),
        ),
    );
    assert!(result.is_err());

    let project: Option<Project> = query(
        &pic,
        backend_id,
        Principal::anonymous(),
        "get_project",
        ("anonymous".to_string(),),
    );
    assert!(project.is_none());
}

#[test]
fn project_writes_reject_oversized_values() {
    let (pic, backend_id) = setup();
    let result: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("x".repeat(129), "req".to_string(), "local".to_string()),
    );
    assert!(result.unwrap_err().contains("project id is too large"));
}

#[test]
fn create_project_rejects_a_duplicate_id() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("p1".to_string(), "req".to_string(), "local".to_string()),
    );
    let second: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "create_project",
        (
            "p1".to_string(),
            "a different request".to_string(),
            "local".to_string(),
        ),
    );
    assert!(second.is_err(), "a duplicate project id must be rejected, not silently overwrite the first - even from a different caller");
}

#[test]
fn add_project_canisters_merges_across_calls_and_is_owner_gated() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("p1".to_string(), "req".to_string(), "local".to_string()),
    );

    let r1: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "add_project_canisters",
        (
            "p1".to_string(),
            vec![("connector".to_string(), connector_id())],
        ),
    );
    r1.expect("first add_project_canisters should succeed");

    let r2: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "add_project_canisters",
        (
            "p1".to_string(),
            vec![("ic-sql".to_string(), database_id())],
        ),
    );
    r2.expect("second add_project_canisters should succeed");

    let project: Project = query::<Option<Project>>(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    )
    .unwrap();
    assert_eq!(
        project.canisters.len(),
        2,
        "both canisters from separate calls should be present"
    );
    assert_eq!(project.canisters.get("connector"), Some(&connector_id()));
    assert_eq!(project.canisters.get("ic-sql"), Some(&database_id()));

    let as_controller: Result<(), String> = call(
        &pic,
        backend_id,
        controller(),
        "add_project_canisters",
        (
            "p1".to_string(),
            vec![("static".to_string(), connector_id())],
        ),
    );
    assert!(as_controller.is_err(), "controller status alone must not grant access - only the project's own owner may add canisters");

    let as_bob: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "add_project_canisters",
        (
            "p1".to_string(),
            vec![("static".to_string(), connector_id())],
        ),
    );
    assert!(
        as_bob.is_err(),
        "a non-owner must not be able to add canisters"
    );
}

#[test]
fn update_project_state_and_set_project_name_and_llm_context_are_owner_gated() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("p1".to_string(), "req".to_string(), "local".to_string()),
    );

    let as_bob: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "update_project_state",
        (
            "p1".to_string(),
            ProjectState::AwaitingAnswer,
            Some("nope".to_string()),
        ),
    );
    assert!(
        as_bob.is_err(),
        "a non-owner must not be able to update project state"
    );

    let r: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "update_project_state",
        (
            "p1".to_string(),
            ProjectState::AwaitingAnswer,
            Some("what retry limit?".to_string()),
        ),
    );
    r.expect("update_project_state should succeed for the owner");

    let r: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "set_project_name",
        ("p1".to_string(), "flight-booking-p1".to_string()),
    );
    r.expect("set_project_name should succeed for the owner");

    let r: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "set_project_llm_context",
        ("p1".to_string(), "# flight-booking-p1\n...".to_string()),
    );
    r.expect("set_project_llm_context should succeed for the owner");

    let project: Project = query::<Option<Project>>(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    )
    .unwrap();
    assert_eq!(project.state, ProjectState::AwaitingAnswer);
    assert_eq!(
        project.pending_question.as_deref(),
        Some("what retry limit?")
    );
    assert_eq!(project.project_name.as_deref(), Some("flight-booking-p1"));
    assert!(project
        .llm_context
        .as_deref()
        .unwrap()
        .starts_with("# flight-booking-p1"));

    let missing: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "set_project_name",
        ("no-such-id".to_string(), "x".to_string()),
    );
    assert!(
        missing.is_err(),
        "updating a non-existent project must fail"
    );
}

#[test]
fn finish_project_succeeds_or_fails_based_on_error_and_clears_pending_question() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        (
            "succeeds".to_string(),
            "req".to_string(),
            "local".to_string(),
        ),
    );
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "update_project_state",
        (
            "succeeds".to_string(),
            ProjectState::AwaitingAnswer,
            Some("q".to_string()),
        ),
    );

    let as_bob: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "finish_project",
        (
            "succeeds".to_string(),
            Some("hijacked".to_string()),
            None::<String>,
        ),
    );
    assert!(
        as_bob.is_err(),
        "a non-owner must not be able to finish someone else's project"
    );

    let r: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "finish_project",
        (
            "succeeds".to_string(),
            Some("all done".to_string()),
            None::<String>,
        ),
    );
    r.expect("finish_project should succeed for the owner");
    let project: Project = query::<Option<Project>>(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("succeeds".to_string(),),
    )
    .unwrap();
    assert_eq!(project.state, ProjectState::Succeeded);
    assert_eq!(project.pending_question, None);
    assert_eq!(project.final_message.as_deref(), Some("all done"));
    assert_eq!(project.error, None);

    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("fails".to_string(), "req".to_string(), "local".to_string()),
    );
    let r: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "finish_project",
        (
            "fails".to_string(),
            None::<String>,
            Some("build failed".to_string()),
        ),
    );
    r.expect("finish_project should succeed even when recording a failure");
    let project: Project = query::<Option<Project>>(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("fails".to_string(),),
    )
    .unwrap();
    assert_eq!(project.state, ProjectState::Failed);
    assert_eq!(project.error.as_deref(), Some("build failed"));
}

#[test]
fn list_my_projects_returns_only_the_caller_s_own_newest_first() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        (
            "older".to_string(),
            "req a".to_string(),
            "local".to_string(),
        ),
    );
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        (
            "newer".to_string(),
            "req b".to_string(),
            "local".to_string(),
        ),
    );
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "create_project",
        ("bobs".to_string(), "req c".to_string(), "local".to_string()),
    );

    let alices: Vec<Project> = query(&pic, backend_id, alice(), "list_my_projects", ());
    assert_eq!(
        alices.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        vec!["newer", "older"],
        "newest first, bob's project excluded"
    );

    let bobs: Vec<Project> = query(&pic, backend_id, bob(), "list_my_projects", ());
    assert_eq!(bobs.len(), 1);
    assert_eq!(bobs[0].id, "bobs");

    let carols: Vec<Project> = query(&pic, backend_id, test_principal(9), "list_my_projects", ());
    assert!(carols.is_empty());
}

#[test]
fn remove_project_canister_is_owner_gated_and_additive_removal_only() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("p1".to_string(), "req".to_string(), "local".to_string()),
    );
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "add_project_canisters",
        (
            "p1".to_string(),
            vec![
                ("connector".to_string(), connector_id()),
                ("ic-sql".to_string(), database_id()),
            ],
        ),
    );

    // The canister's own controller (not the owner) must not be able to
    // remove a canister - this is the owner's own self-service action, taken
    // directly from the dashboard after a real `delete_canister` call
    // succeeds, never something a controller identity does on its own.
    let as_controller: Result<(), String> = call(
        &pic,
        backend_id,
        controller(),
        "remove_project_canister",
        ("p1".to_string(), "connector".to_string()),
    );
    assert!(
        as_controller.is_err(),
        "controller status alone must not grant access to remove a canister"
    );

    let as_bob: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "remove_project_canister",
        ("p1".to_string(), "connector".to_string()),
    );
    assert!(
        as_bob.is_err(),
        "a non-owner must not be able to remove a canister"
    );

    let as_owner: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "remove_project_canister",
        ("p1".to_string(), "connector".to_string()),
    );
    as_owner.expect("the project's own owner should be able to remove one of its canisters");

    let project: Project = query::<Option<Project>>(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    )
    .unwrap();
    assert_eq!(
        project.canisters.len(),
        1,
        "only the named canister should be removed"
    );
    assert!(!project.canisters.contains_key("connector"));
    assert_eq!(project.canisters.get("ic-sql"), Some(&database_id()));

    // Removing a name that was never tracked (or already removed) is not an
    // error - the end state it asks for already holds.
    let remove_again: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "remove_project_canister",
        ("p1".to_string(), "connector".to_string()),
    );
    remove_again.expect("removing an already-absent canister name should be a no-op success");

    let missing_project: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "remove_project_canister",
        ("no-such-id".to_string(), "connector".to_string()),
    );
    assert!(missing_project.is_err());
}

#[test]
fn delete_project_is_owner_gated_and_actually_removes_the_record() {
    let (pic, backend_id) = setup();
    let _: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "create_project",
        ("p1".to_string(), "req".to_string(), "local".to_string()),
    );

    let as_controller: Result<(), String> = call(
        &pic,
        backend_id,
        controller(),
        "delete_project",
        ("p1".to_string(),),
    );
    assert!(
        as_controller.is_err(),
        "controller status alone must not grant access to delete a project"
    );

    let as_bob: Result<(), String> = call(
        &pic,
        backend_id,
        bob(),
        "delete_project",
        ("p1".to_string(),),
    );
    assert!(
        as_bob.is_err(),
        "a non-owner must not be able to delete a project"
    );

    // Rejected attempts must not have touched anything.
    let still_there: Option<Project> = query(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    );
    assert!(still_there.is_some());

    let as_owner: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "delete_project",
        ("p1".to_string(),),
    );
    as_owner.expect("the project's own owner should be able to delete it");

    let gone: Option<Project> = query(
        &pic,
        backend_id,
        alice(),
        "get_project",
        ("p1".to_string(),),
    );
    assert!(
        gone.is_none(),
        "the record must actually be gone, not just hidden"
    );

    let listed: Vec<Project> = query(&pic, backend_id, alice(), "list_my_projects", ());
    assert!(
        listed.is_empty(),
        "a deleted project must not still appear in list_my_projects"
    );

    let missing: Result<(), String> = call(
        &pic,
        backend_id,
        alice(),
        "delete_project",
        ("p1".to_string(),),
    );
    assert!(
        missing.is_err(),
        "deleting an already-deleted project must fail, not silently succeed"
    );
}
