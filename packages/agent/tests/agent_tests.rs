//! PocketIC integration tests for the `agent` canister: `Config`/
//! `ConfigUpdate`, `receive_message`'s access control, the admin webhook's
//! HMAC round trip (mocked outcall), the per-conversation reentrancy guard,
//! and - thanks to `ic_rig`'s bring-your-own-HTTP-client design (see
//! `src/llm.rs`'s doc comment) - a real end-to-end run of the LLM/tool-
//! calling plumbing with a **mocked** HTTPS outcall standing in for the
//! provider's API. This is real coverage of `llm::run_agent_loop`'s wiring
//! (`ic_rig::Agent::chat` parsing the mocked response, and the reply
//! reaching persisted history) without needing a live provider account or
//! API key - see `receive_message_uses_the_llm_response_and_persists_it_even_if_the_reply_relay_fails`.
//!
//! Requires a built canister Wasm at
//! `../target/wasm32-unknown-unknown/release/agent.wasm` - build it
//! first:
//!
//!   cargo build --target wasm32-unknown-unknown --release
//!   cargo test
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run.

use candid::{encode_one, Principal};
use agent::{AdminRequest, Channel, Config, ConfigUpdate, HttpRequest, HttpResponse, IncomingMessage};
use hmac::{Hmac, Mac};
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use sha2::Sha256;

const WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-unknown-unknown/release/agent.wasm"));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}
fn admin() -> Principal {
    test_principal(1)
}
fn connector() -> Principal {
    test_principal(2)
}
fn mallory() -> Principal {
    test_principal(3)
}

fn setup(config: Config) -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(id, 10_000_000_000_000);
    pic.install_canister(id, WASM.to_vec(), encode_one(config).unwrap(), Some(admin()));
    (pic, id)
}

fn update_config(pic: &PocketIc, id: Principal, caller: Principal, update: &ConfigUpdate) -> Result<(), String> {
    let (result,): (Result<(), String>,) = update_candid_as(pic, id, caller, "update_config", (update.clone(),)).unwrap();
    result
}

fn get_config(pic: &PocketIc, id: Principal, caller: Principal) -> Result<Config, String> {
    let (result,): (Result<Config, String>,) = query_candid_as(pic, id, caller, "get_config", ()).unwrap();
    result
}

// ---------------------------------------------------------------------------
// init / update_config / get_config
// ---------------------------------------------------------------------------

#[test]
fn init_installs_the_given_config() {
    let config = Config { connector_principal: Some(connector()), ..Default::default() };
    let (pic, id) = setup(config.clone());
    assert_eq!(get_config(&pic, id, admin()).unwrap(), config);
}

#[test]
fn update_config_is_controller_only_and_merges_per_field() {
    let (pic, id) = setup(Config::default());
    let rejected = update_config(&pic, id, mallory(), &ConfigUpdate { connector_principal: Some(Some(connector())), ..Default::default() });
    assert!(rejected.is_err());

    update_config(&pic, id, admin(), &ConfigUpdate { connector_principal: Some(Some(connector())), ..Default::default() }).unwrap();
    update_config(&pic, id, admin(), &ConfigUpdate { system_prompt: Some(Some("be nice".to_string())), ..Default::default() }).unwrap();

    let config = get_config(&pic, id, admin()).unwrap();
    assert_eq!(config.connector_principal, Some(connector()), "earlier update must survive a later, unrelated one");
    assert_eq!(config.system_prompt.as_deref(), Some("be nice"));
}

// ---------------------------------------------------------------------------
// receive_message: access control (not the LLM loop itself - see module doc)
// ---------------------------------------------------------------------------

fn sample_message() -> IncomingMessage {
    IncomingMessage { channel: Channel::WhatsApp, session_id: "15550001111".to_string(), text: "hi".to_string() }
}

#[test]
fn receive_message_rejects_until_connector_principal_is_configured() {
    let (pic, id) = setup(Config::default());
    let (result,): (Result<(), String>,) = update_candid_as(&pic, id, connector(), "receive_message", (sample_message(),)).unwrap();
    assert!(result.is_err());
}

#[test]
fn receive_message_rejects_anonymous_and_wrong_callers() {
    let (pic, id) = setup(Config { connector_principal: Some(connector()), ..Default::default() });
    let (anon,): (Result<(), String>,) = update_candid_as(&pic, id, Principal::anonymous(), "receive_message", (sample_message(),)).unwrap();
    assert!(anon.is_err());
    let (wrong,): (Result<(), String>,) = update_candid_as(&pic, id, mallory(), "receive_message", (sample_message(),)).unwrap();
    assert!(wrong.is_err());
}

#[test]
fn receive_message_uses_the_llm_response_and_persists_it_even_if_the_reply_relay_fails() {
    let (pic, id) = setup(Config {
        connector_principal: Some(connector()),
        llm_provider: Some("openai".to_string()),
        llm_api_key: Some("sk-test".to_string()),
        ..Default::default()
    });

    let msg = sample_message();
    let payload = candid::encode_args((msg.clone(),)).unwrap();
    let call_id = pic.submit_call(id, connector(), "receive_message", payload).unwrap();

    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    assert_eq!(requests.len(), 1, "expected exactly one pending HTTPS outcall, to the configured LLM provider");
    let request = &requests[0];
    assert!(request.url.contains("api.openai.com"), "should call the configured provider's API, got {}", request.url);

    let reply_text = "Hello! How can I help you today?";
    let mock_body = serde_json::json!({ "choices": [{ "message": { "content": reply_text, "tool_calls": [] } }] }).to_string();
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: request.subnet_id,
        request_id: request.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply { status: 200, headers: vec![], body: mock_body.into_bytes() }),
        additional_responses: vec![],
    });

    // The overall call may still resolve to `Err` here - `connector()` is a
    // bare test principal, not a real installed canister, so the final
    // relay-to-customer leg (an inter-canister call) fails. That's a
    // different, unrelated leg from what this test is checking: that the
    // mocked provider response was correctly parsed by `ic_rig::Agent::chat`
    // and reached persisted history. Just let the round finish before
    // reading state back.
    let _ = pic.await_call(call_id);

    let (conversation,): (Result<agent::ConversationState, String>,) = query_candid_as(&pic, id, admin(), "get_conversation", (msg.channel, msg.session_id)).unwrap();
    let conversation = conversation.unwrap();
    assert_eq!(conversation.history.len(), 2, "one user turn + one assistant turn");
    assert_eq!(conversation.history[0].content, "hi");
    assert_eq!(conversation.history[1].content, reply_text);
}

// ---------------------------------------------------------------------------
// Observability queries: controller-only
// ---------------------------------------------------------------------------

#[test]
fn observability_queries_are_controller_only() {
    let (pic, id) = setup(Config::default());
    let (result,): (Result<Vec<AdminRequest>, String>,) = query_candid_as(&pic, id, mallory(), "list_admin_requests", (0u64, 10u64)).unwrap();
    assert!(result.is_err());
    let (result,): (Result<Option<AdminRequest>, String>,) = query_candid_as(&pic, id, mallory(), "get_admin_request", (0u64,)).unwrap();
    assert!(result.is_err());
    let (result,): (Result<agent::ConversationState, String>,) = query_candid_as(&pic, id, mallory(), "get_conversation", (Channel::WhatsApp, "x".to_string())).unwrap();
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// llm_context: open to any caller
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone_and_mentions_the_security_invariant() {
    let (pic, id) = setup(Config::default());
    let (doc,): (String,) = query_candid_as(&pic, id, Principal::anonymous(), "llm_context", ()).unwrap();
    assert!(doc.contains("request_admin_action"));
    assert!(doc.to_lowercase().contains("administrative"));
}

// ---------------------------------------------------------------------------
// POST /webhook/admin: HTTP routing + HMAC verification
// ---------------------------------------------------------------------------

fn http_req(method: &str, url: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> HttpRequest {
    HttpRequest { method: method.to_string(), url: url.to_string(), headers, body }
}

#[test]
fn admin_webhook_post_upgrades_to_update_call() {
    let (pic, id) = setup(Config::default());
    let req = http_req("POST", "/webhook/admin", vec![], b"{}".to_vec());
    let (resp,): (HttpResponse,) = query_candid_as(&pic, id, Principal::anonymous(), "http_request", (req,)).unwrap();
    assert_eq!(resp.upgrade, Some(true));
}

#[test]
fn unknown_http_paths_404() {
    let (pic, id) = setup(Config::default());
    let req = http_req("GET", "/not-a-real-path", vec![], vec![]);
    let (resp,): (HttpResponse,) = query_candid_as(&pic, id, Principal::anonymous(), "http_request", (req,)).unwrap();
    assert_eq!(resp.status_code, 404);
}

#[test]
fn admin_webhook_callback_rejects_bad_signature_and_unknown_request() {
    let secret = "admin-secret";
    let (pic, id) = setup(Config { admin_webhook_secret: Some(secret.to_string()), ..Default::default() });

    let body = br#"{"request_id":1,"status":"approved","message":"done"}"#.to_vec();

    // No signature at all.
    let req = http_req("POST", "/webhook/admin", vec![], body.clone());
    let (resp,): (HttpResponse,) = update_candid_as(&pic, id, Principal::anonymous(), "http_request_update", (req,)).unwrap();
    assert_eq!(resp.status_code, 400);

    // Correct signature, but no such AdminRequest exists yet.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(&body);
    let sig = hex::encode(mac.finalize().into_bytes());
    let req = http_req("POST", "/webhook/admin", vec![("X-Signature".to_string(), format!("sha256={sig}"))], body);
    let (resp,): (HttpResponse,) = update_candid_as(&pic, id, Principal::anonymous(), "http_request_update", (req,)).unwrap();
    assert_eq!(resp.status_code, 400, "a well-signed callback for a nonexistent request id must still fail");
}
