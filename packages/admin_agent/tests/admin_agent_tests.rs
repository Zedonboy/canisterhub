//! PocketIC integration tests for the `admin_agent` canister: `Config`/
//! `ConfigUpdate`, `require_admin` gating on every method, the direct
//! candid action methods succeeding end to end (which is where
//! `ic_cdk::api::msg_caller()`/`state::log_action` actually run - see
//! `src/tools.rs`'s unit tests for why those are tested here, not there),
//! the audit log, and - thanks to `ic_rig`'s bring-your-own-HTTP-client
//! design (see `src/llm.rs`'s doc comment) - a real end-to-end run of
//! `chat`'s LLM/tool-calling loop with a **mocked** HTTPS outcall standing
//! in for the provider's API, including the model actually calling
//! `issue_refund` and that call landing in the audit log.
//!
//! Requires a built canister Wasm at
//! `../target/wasm32-unknown-unknown/release/admin_agent.wasm` - build it
//! first:
//!
//!   cargo build --target wasm32-unknown-unknown --release
//!   cargo test
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run.

use admin_agent::{ActionLogEntry, ChatTurn, Config, ConfigUpdate, Role};
use candid::{encode_one, Principal};
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};

const WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-unknown-unknown/release/admin_agent.wasm"));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}
fn controller() -> Principal {
    test_principal(1)
}
fn admin() -> Principal {
    test_principal(2)
}
fn mallory() -> Principal {
    test_principal(3)
}

fn setup(config: Config) -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(controller()), None);
    pic.add_cycles(id, 10_000_000_000_000);
    pic.install_canister(id, WASM.to_vec(), encode_one(config).unwrap(), Some(controller()));
    (pic, id)
}

fn get_config(pic: &PocketIc, id: Principal, caller: Principal) -> Result<Config, String> {
    let (result,): (Result<Config, String>,) = query_candid_as(pic, id, caller, "get_config", ()).unwrap();
    result
}

fn update_config(pic: &PocketIc, id: Principal, caller: Principal, update: &ConfigUpdate) -> Result<(), String> {
    let (result,): (Result<(), String>,) = update_candid_as(pic, id, caller, "update_config", (update.clone(),)).unwrap();
    result
}

fn issue_refund(pic: &PocketIc, id: Principal, caller: Principal, order_id: &str, amount_cents: u64, reason: &str) -> Result<String, String> {
    let (result,): (Result<String, String>,) = update_candid_as(pic, id, caller, "issue_refund", (order_id.to_string(), amount_cents, reason.to_string())).unwrap();
    result
}

fn set_account_status(pic: &PocketIc, id: Principal, caller: Principal, customer_ref: &str, status: &str) -> Result<String, String> {
    let (result,): (Result<String, String>,) = update_candid_as(pic, id, caller, "set_account_status", (customer_ref.to_string(), status.to_string())).unwrap();
    result
}

fn list_action_log(pic: &PocketIc, id: Principal, caller: Principal) -> Result<Vec<ActionLogEntry>, String> {
    let (result,): (Result<Vec<ActionLogEntry>, String>,) = query_candid_as(pic, id, caller, "list_action_log", (0u64, 10u64)).unwrap();
    result
}

// ---------------------------------------------------------------------------
// init / update_config / get_config
// ---------------------------------------------------------------------------

#[test]
fn init_installs_the_given_config() {
    let config = Config { admins: vec![admin()], ..Default::default() };
    let (pic, id) = setup(config.clone());
    assert_eq!(get_config(&pic, id, controller()).unwrap(), config);
}

#[test]
fn update_config_is_controller_only() {
    let (pic, id) = setup(Config::default());
    let result = update_config(&pic, id, mallory(), &ConfigUpdate { admins: Some(vec![admin()]), ..Default::default() });
    assert!(result.is_err());
    let result = update_config(&pic, id, admin(), &ConfigUpdate { admins: Some(vec![admin()]), ..Default::default() });
    assert!(result.is_err(), "an admin is not automatically a controller");
}

#[test]
fn get_config_is_controller_only() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    assert!(get_config(&pic, id, admin()).is_err(), "an admin is not automatically a controller");
    assert!(get_config(&pic, id, mallory()).is_err());
}

// ---------------------------------------------------------------------------
// require_admin gating, on every gated method
// ---------------------------------------------------------------------------

#[test]
fn actions_reject_non_admin_non_controller_callers() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    assert!(issue_refund(&pic, id, mallory(), "ORD-1", 100, "x").is_err());
    assert!(set_account_status(&pic, id, mallory(), "cust-1", "active").is_err());
    assert!(list_action_log(&pic, id, mallory()).is_err());
}

#[test]
fn actions_accept_configured_admins_and_controllers() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    assert!(issue_refund(&pic, id, admin(), "ORD-1", 100, "damaged").is_ok());
    assert!(issue_refund(&pic, id, controller(), "ORD-2", 200, "duplicate").is_ok());
}

#[test]
fn actions_reject_everyone_when_no_admins_are_configured_except_a_controller() {
    let (pic, id) = setup(Config::default());
    assert!(issue_refund(&pic, id, admin(), "ORD-1", 100, "x").is_err(), "not configured as an admin");
    assert!(issue_refund(&pic, id, controller(), "ORD-1", 100, "x").is_ok(), "a controller may always act");
}

// ---------------------------------------------------------------------------
// Actions succeed end to end and are logged
// ---------------------------------------------------------------------------

#[test]
fn issue_refund_succeeds_and_reports_back_what_it_did() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    let result = issue_refund(&pic, id, admin(), "ORD-42", 1500, "damaged in transit").unwrap();
    assert!(result.contains("ORD-42"));
    assert!(result.contains("1500"));
}

#[test]
fn set_account_status_rejects_unknown_status_and_accepts_known_ones() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    assert!(set_account_status(&pic, id, admin(), "cust-1", "on-fire").is_err());
    for status in ["active", "suspended", "banned"] {
        assert!(set_account_status(&pic, id, admin(), "cust-1", status).is_ok());
    }
}

#[test]
fn every_action_is_recorded_in_the_audit_log_attributed_to_its_caller() {
    let (pic, id) = setup(Config { admins: vec![admin()], ..Default::default() });
    issue_refund(&pic, id, admin(), "ORD-1", 100, "x").unwrap();
    set_account_status(&pic, id, admin(), "cust-1", "suspended").unwrap();

    let log = list_action_log(&pic, id, admin()).unwrap();
    assert_eq!(log.len(), 2);
    // Newest-first.
    assert_eq!(log[0].action, "set_account_status");
    assert_eq!(log[1].action, "issue_refund");
    assert!(log.iter().all(|e| e.admin == admin()));
}

// ---------------------------------------------------------------------------
// chat: real tool-calling loop, HTTPS outcall to the provider mocked
// ---------------------------------------------------------------------------

/// Waits for `chat`'s pending HTTPS outcall to appear and returns it -
/// mirrors `backend/tests/marketplace_tests.rs`'s mock-outcall pattern.
fn wait_for_outcall(pic: &PocketIc) -> pocket_ic::common::rest::CanisterHttpRequest {
    for _ in 0..10 {
        pic.tick();
        let requests = pic.get_canister_http();
        if !requests.is_empty() {
            return requests.into_iter().next().unwrap();
        }
    }
    panic!("expected a pending HTTPS outcall to the LLM provider");
}

fn mock_response(pic: &PocketIc, request: &pocket_ic::common::rest::CanisterHttpRequest, status: u16, body: String) {
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: request.subnet_id,
        request_id: request.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply { status, headers: vec![], body: body.into_bytes() }),
        additional_responses: vec![],
    });
}

#[test]
fn chat_dispatches_a_tool_call_from_the_mocked_response_and_logs_it() {
    let (pic, id) = setup(Config { admins: vec![admin()], llm_provider: Some("openai".to_string()), llm_api_key: Some("sk-test".to_string()), ..Default::default() });

    let payload = candid::encode_args((Vec::<ChatTurn>::new(), "please refund order ORD-99, 500 cents, test reason".to_string())).unwrap();
    let call_id = pic.submit_call(id, admin(), "chat", payload).unwrap();

    // Round 1: the (mocked) model asks to call `issue_refund`.
    let request = wait_for_outcall(&pic);
    let tool_call_body = serde_json::json!({
        "choices": [{
            "message": {
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "function": { "name": "issue_refund", "arguments": "{\"order_id\":\"ORD-99\",\"amount_cents\":500,\"reason\":\"test\"}" }
                }]
            }
        }]
    })
    .to_string();
    mock_response(&pic, &request, 200, tool_call_body);

    // Round 2: having seen the tool's result, the (mocked) model gives a
    // final plain-text reply.
    let request = wait_for_outcall(&pic);
    let final_body = serde_json::json!({ "choices": [{ "message": { "content": "Done - refund issued.", "tool_calls": [] } }] }).to_string();
    mock_response(&pic, &request, 200, final_body);

    let reply = pic.await_call(call_id).unwrap();
    let (result,): (Result<Vec<ChatTurn>, String>,) = candid::decode_args(&reply).unwrap();
    let turns = result.unwrap();
    let last = turns.last().expect("chat should return a non-empty conversation");
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.content, "Done - refund issued.");

    // Proof the tool call was actually dispatched to the real
    // `issue_refund` function (not just echoed) - it logged itself.
    let log = list_action_log(&pic, id, admin()).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].action, "issue_refund");
    assert!(log[0].details.contains("ORD-99"));
    assert_eq!(log[0].admin, admin(), "the action must be attributed to whoever called chat");
}

// ---------------------------------------------------------------------------
// llm_context: open to any caller
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone_and_mentions_require_admin() {
    let (pic, id) = setup(Config::default());
    let (doc,): (String,) = query_candid_as(&pic, id, Principal::anonymous(), "llm_context", ()).unwrap();
    assert!(doc.contains("require_admin"));
    assert!(doc.contains("issue_refund"));
}
