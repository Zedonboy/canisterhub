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

use agent::{
    AdminRequest, AiCanister, Channel, Config, ConfigUpdate, HttpRequest, HttpResponse,
    IncomingMessage,
};
use candid::{encode_args, encode_one, CandidType, Principal};
use hmac::{Hmac, Mac};
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use sha2::Sha256;
use std::collections::HashMap;

#[derive(CandidType, serde::Deserialize, Clone, Debug)]
enum DynamicConfigValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
    Vector(Vec<DynamicConfigVectorValue>),
}

#[derive(CandidType, serde::Deserialize, Clone, Debug)]
enum DynamicConfigVectorValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
}

#[derive(CandidType, serde::Deserialize)]
struct ReadonlySchemaField {
    key: String,
    default_value: Option<DynamicConfigValue>,
    is_readonly: Option<bool>,
    group: Option<String>,
    group_label: Option<String>,
    group_description: Option<String>,
}

#[derive(CandidType, serde::Deserialize, Debug, PartialEq, Eq)]
enum LinkKind {
    Admin,
    Public,
}

#[derive(CandidType, serde::Deserialize, Debug, PartialEq, Eq)]
struct CanisterLink {
    label: String,
    url: String,
    kind: LinkKind,
}

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/agent.wasm"
));
const APP_API_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/app_api.wasm"
));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn crate_protocol_id() -> &'static str {
    "ibrml-ld777-77774-qaabq-cai"
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

fn setup_with_arg(arg: Vec<u8>) -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(id, 10_000_000_000_000);
    pic.install_canister(id, WASM.to_vec(), arg, Some(admin()));
    (pic, id)
}

fn setup(config: Config) -> (PocketIc, Principal) {
    setup_with_arg(encode_one(config).unwrap())
}

fn update_config(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
    update: &ConfigUpdate,
) -> Result<(), String> {
    let (result,): (Result<(), String>,) =
        update_candid_as(pic, id, caller, "update_config", (update.clone(),)).unwrap();
    result
}

fn get_config(pic: &PocketIc, id: Principal, caller: Principal) -> Result<Config, String> {
    let (result,): (Result<Config, String>,) =
        query_candid_as(pic, id, caller, "get_runtime_config", ()).unwrap();
    result
}

// ---------------------------------------------------------------------------
// init / update_config / get_config
// ---------------------------------------------------------------------------

#[test]
fn init_installs_the_given_config() {
    let config = Config {
        mail_bridge_principal: Some(connector()),
        ..Default::default()
    };
    let (pic, id) = setup(config.clone());
    assert_eq!(get_config(&pic, id, admin()).unwrap(), config);
}

#[test]
fn init_without_an_argument_uses_default_config() {
    let (pic, id) = setup_with_arg(encode_args(()).unwrap());
    assert_eq!(get_config(&pic, id, admin()).unwrap(), Config::default());
}

#[test]
fn update_config_is_controller_only_and_merges_per_field() {
    let (pic, id) = setup(Config::default());
    let rejected = update_config(
        &pic,
        id,
        mallory(),
        &ConfigUpdate {
            mail_bridge_principal: Some(Some(connector())),
            ..Default::default()
        },
    );
    assert!(rejected.is_err());

    update_config(
        &pic,
        id,
        admin(),
        &ConfigUpdate {
            mail_bridge_principal: Some(Some(connector())),
            ..Default::default()
        },
    )
    .unwrap();
    update_config(
        &pic,
        id,
        admin(),
        &ConfigUpdate {
            system_prompt: Some(Some("be nice".to_string())),
            ..Default::default()
        },
    )
    .unwrap();

    let config = get_config(&pic, id, admin()).unwrap();
    assert_eq!(
        config.mail_bridge_principal,
        Some(connector()),
        "earlier update must survive a later, unrelated one"
    );
    assert_eq!(config.system_prompt.as_deref(), Some("be nice"));
}

#[test]
fn dynamic_config_lists_agentic_canisters_and_read_only_channel_endpoints() {
    let (pic, id) = setup(Config::default());
    let (schema,): (Vec<ReadonlySchemaField>,) =
        query_candid_as(&pic, id, admin(), "get_config_schema", ()).unwrap();
    assert_eq!(schema.len(), 25);
    let whatsapp = schema
        .iter()
        .find(|field| field.key == "whatsapp_webhook_url")
        .expect("WhatsApp endpoint schema");
    assert_eq!(whatsapp.group.as_deref(), Some("whatsapp"));
    assert_eq!(whatsapp.group_label.as_deref(), Some("WhatsApp"));
    assert!(whatsapp
        .group_description
        .as_deref()
        .is_some_and(|description| description.contains("WhatsApp Business")));
    let editable = schema
        .iter()
        .filter(|field| field.is_readonly == Some(false))
        .map(|field| field.key.as_str())
        .collect::<Vec<_>>();
    assert_eq!(editable.len(), 20);
    for key in [
        "connected_canisters",
        "project_id",
        "protocol_id",
        "system_prompt",
        "llm_provider",
        "llm_api_key",
        "whatsapp_verify_token",
        "telegram_bot_token",
        "mail_bridge_api_key",
        "admin_webhook_secret",
    ] {
        assert!(editable.contains(&key), "missing dynamic config key {key}");
    }
    let protocol = schema
        .iter()
        .find(|field| field.key == "protocol_id")
        .expect("protocol schema");
    assert!(matches!(
        protocol.default_value.as_ref(),
        Some(DynamicConfigValue::PrincipalId(id))
            if id.to_text() == crate_protocol_id()
    ));

    let (values,): (HashMap<String, DynamicConfigValue>,) =
        query_candid_as(&pic, id, admin(), "get_config", ()).unwrap();
    assert!(matches!(
        values.get("agent_canister_id"),
        Some(DynamicConfigValue::PrincipalId(value)) if *value == id
    ));
    assert!(matches!(
        values.get("protocol_id"),
        Some(DynamicConfigValue::PrincipalId(value))
            if value.to_text() == crate_protocol_id()
    ));

    let update = HashMap::from([
        (
            "system_prompt".to_string(),
            DynamicConfigValue::Text("Be concise".to_string()),
        ),
        (
            "llm_api_key".to_string(),
            DynamicConfigValue::Text("write-only-secret".to_string()),
        ),
        (
            "max_tool_iterations".to_string(),
            DynamicConfigValue::Number(9),
        ),
    ]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, id, admin(), "set_config", (update,)).unwrap();
    result.unwrap();
    let runtime = get_config(&pic, id, admin()).unwrap();
    assert_eq!(runtime.system_prompt.as_deref(), Some("Be concise"));
    assert_eq!(runtime.llm_api_key.as_deref(), Some("write-only-secret"));
    assert_eq!(runtime.max_tool_iterations, Some(9));
    let (refreshed,): (HashMap<String, DynamicConfigValue>,) =
        query_candid_as(&pic, id, admin(), "get_config", ()).unwrap();
    assert!(matches!(
        refreshed.get("system_prompt"),
        Some(DynamicConfigValue::Text(value)) if value == "Be concise"
    ));
    assert!(
        !refreshed.contains_key("llm_api_key"),
        "dynamic config must never return stored secrets"
    );
    assert!(matches!(
        values.get("connected_canisters"),
        Some(DynamicConfigValue::Vector(values)) if values.is_empty()
    ));
    for (key, path) in [
        ("whatsapp_webhook_url", "/webhook/whatsapp"),
        ("telegram_webhook_url", "/webhook/telegram"),
        ("admin_callback_webhook_url", "/webhook/admin"),
    ] {
        let Some(DynamicConfigValue::Text(value)) = values.get(key) else {
            panic!("missing {key}");
        };
        assert_eq!(value, &format!("https://{id}.icp0.io{path}"));
    }

    let update = HashMap::from([(
        "whatsapp_webhook_url".to_string(),
        DynamicConfigValue::Text("https://example.invalid".to_string()),
    )]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, id, admin(), "set_config", (update,)).unwrap();
    assert!(result.unwrap_err().contains("read-only"));
}

#[test]
fn dynamic_config_adds_and_removes_agentic_canisters_through_llm_context_discovery() {
    let (pic, agent_id) = setup(Config::default());
    let tool_id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(tool_id, 10_000_000_000_000);
    pic.install_canister(
        tool_id,
        APP_API_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(admin()),
    );

    let update = HashMap::from([(
        "connected_canisters".to_string(),
        DynamicConfigValue::Vector(vec![DynamicConfigVectorValue::PrincipalId(tool_id)]),
    )]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, agent_id, admin(), "set_config", (update,)).unwrap();
    result.expect("dynamic config should discover the canister's llm_context");

    let (listed,): (Result<Vec<AiCanister>, String>,) =
        query_candid_as(&pic, agent_id, admin(), "list_canisters", ()).unwrap();
    let listed = listed.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].canister_id, tool_id);
    assert_eq!(listed[0].methods[0].name, "ai_health");

    let clear = HashMap::from([(
        "connected_canisters".to_string(),
        DynamicConfigValue::Vector(vec![]),
    )]);
    let (result,): (Result<(), String>,) =
        update_candid_as(&pic, agent_id, admin(), "set_config", (clear,)).unwrap();
    result.expect("empty vector should remove registered canisters");

    let (listed,): (Result<Vec<AiCanister>, String>,) =
        query_candid_as(&pic, agent_id, admin(), "list_canisters", ()).unwrap();
    assert!(listed.unwrap().is_empty());
}

#[test]
fn add_canister_discovers_and_persists_declared_ai_methods() {
    let (pic, agent_id) = setup(Config::default());
    let tool_id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(tool_id, 10_000_000_000_000);
    pic.install_canister(
        tool_id,
        APP_API_WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(admin()),
    );

    let (added,): (Result<AiCanister, String>,) =
        update_candid_as(&pic, agent_id, admin(), "add_canister", (tool_id,)).unwrap();
    let added = added.expect("registration should discover app_api's llm_context");
    assert_eq!(added.canister_id, tool_id);
    assert_eq!(added.methods.len(), 1);
    assert_eq!(added.methods[0].name, "ai_health");

    let (listed,): (Result<Vec<AiCanister>, String>,) =
        query_candid_as(&pic, agent_id, admin(), "list_canisters", ()).unwrap();
    assert_eq!(listed.unwrap(), vec![added]);
}

// ---------------------------------------------------------------------------
// receive_message: access control (not the LLM loop itself - see module doc)
// ---------------------------------------------------------------------------

fn sample_message() -> IncomingMessage {
    IncomingMessage {
        channel: Channel::WhatsApp,
        session_id: "15550001111".to_string(),
        text: "hi".to_string(),
    }
}

#[test]
fn receive_message_is_controller_only() {
    let (pic, id) = setup(Config::default());
    let (result,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        connector(),
        "receive_message",
        (sample_message(),),
    )
    .unwrap();
    assert!(result.is_err());
}

#[test]
fn receive_message_rejects_anonymous_and_wrong_callers() {
    let (pic, id) = setup(Config::default());
    let (anon,): (Result<(), String>,) = update_candid_as(
        &pic,
        id,
        Principal::anonymous(),
        "receive_message",
        (sample_message(),),
    )
    .unwrap();
    assert!(anon.is_err());
    let (wrong,): (Result<(), String>,) =
        update_candid_as(&pic, id, mallory(), "receive_message", (sample_message(),)).unwrap();
    assert!(wrong.is_err());
}

#[test]
fn receive_message_uses_the_llm_response_and_persists_it_even_if_the_reply_relay_fails() {
    let (pic, id) = setup(Config {
        llm_provider: Some("openai".to_string()),
        llm_api_key: Some("sk-test".to_string()),
        ..Default::default()
    });

    let msg = sample_message();
    let payload = candid::encode_args((msg.clone(),)).unwrap();
    let call_id = pic
        .submit_call(id, admin(), "receive_message", payload)
        .unwrap();

    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    assert_eq!(
        requests.len(),
        1,
        "expected exactly one pending HTTPS outcall, to the configured LLM provider"
    );
    let request = &requests[0];
    assert!(
        request.url.contains("api.openai.com"),
        "should call the configured provider's API, got {}",
        request.url
    );

    let reply_text = "Hello! How can I help you today?";
    let mock_body = serde_json::json!({ "choices": [{ "message": { "content": reply_text, "tool_calls": [] } }] }).to_string();
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: request.subnet_id,
        request_id: request.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 200,
            headers: vec![],
            body: mock_body.into_bytes(),
        }),
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

    let (conversation,): (Result<agent::ConversationState, String>,) = query_candid_as(
        &pic,
        id,
        admin(),
        "get_conversation",
        (msg.channel, msg.session_id),
    )
    .unwrap();
    let conversation = conversation.unwrap();
    assert_eq!(
        conversation.history.len(),
        2,
        "one user turn + one assistant turn"
    );
    assert_eq!(conversation.history[0].content, "hi");
    assert_eq!(conversation.history[1].content, reply_text);
}

// ---------------------------------------------------------------------------
// Observability queries: controller-only
// ---------------------------------------------------------------------------

#[test]
fn observability_queries_are_controller_only() {
    let (pic, id) = setup(Config::default());
    let (result,): (Result<Vec<AdminRequest>, String>,) =
        query_candid_as(&pic, id, mallory(), "list_admin_requests", (0u64, 10u64)).unwrap();
    assert!(result.is_err());
    let (result,): (Result<Option<AdminRequest>, String>,) =
        query_candid_as(&pic, id, mallory(), "get_admin_request", (0u64,)).unwrap();
    assert!(result.is_err());
    let (result,): (Result<agent::ConversationState, String>,) = query_candid_as(
        &pic,
        id,
        mallory(),
        "get_conversation",
        (Channel::WhatsApp, "x".to_string()),
    )
    .unwrap();
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// llm_context: open to any caller
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone_and_documents_dynamic_ai_methods() {
    let (pic, id) = setup(Config::default());
    let (doc,): (String,) =
        query_candid_as(&pic, id, Principal::anonymous(), "llm_context", ()).unwrap();
    assert!(doc.contains("add_canister"));
    assert!(doc.contains("ai_*"));
    assert!(doc.contains("AiContext"));
}

// ---------------------------------------------------------------------------
// POST /webhook/admin: HTTP routing + HMAC verification
// ---------------------------------------------------------------------------

fn http_req(method: &str, url: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> HttpRequest {
    HttpRequest {
        method: method.to_string(),
        url: url.to_string(),
        headers,
        body,
    }
}

#[test]
fn admin_webhook_post_upgrades_to_update_call() {
    let (pic, id) = setup(Config::default());
    let req = http_req("POST", "/webhook/admin", vec![], b"{}".to_vec());
    let (resp,): (HttpResponse,) =
        query_candid_as(&pic, id, Principal::anonymous(), "http_request", (req,)).unwrap();
    assert_eq!(resp.upgrade, Some(true));
}

#[test]
fn declared_links_load_the_embedded_chat_ui() {
    let (pic, id) = setup(Config::default());
    let (links,): (Vec<CanisterLink>,) =
        query_candid_as(&pic, id, Principal::anonymous(), "get_links", ()).unwrap();
    assert_eq!(
        links,
        vec![
            CanisterLink {
                label: "SME Inbox".to_string(),
                url: "/inbox".to_string(),
                kind: LinkKind::Admin,
            },
            CanisterLink {
                label: "Customer Chat".to_string(),
                url: "/chat".to_string(),
                kind: LinkKind::Public,
            },
        ]
    );

    for link in links {
        let req = http_req("GET", &link.url, vec![], vec![]);
        let (resp,): (HttpResponse,) =
            query_candid_as(&pic, id, Principal::anonymous(), "http_request", (req,)).unwrap();
        assert_eq!(resp.status_code, 200);
        assert!(resp.body.starts_with(b"<!doctype html>"));
        assert!(resp
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
    }
}

#[test]
fn unknown_http_paths_404() {
    let (pic, id) = setup(Config::default());
    let req = http_req("GET", "/not-a-real-path", vec![], vec![]);
    let (resp,): (HttpResponse,) =
        query_candid_as(&pic, id, Principal::anonymous(), "http_request", (req,)).unwrap();
    assert_eq!(resp.status_code, 404);
}

#[test]
fn admin_webhook_callback_rejects_bad_signature_and_unknown_request() {
    let secret = "admin-secret";
    let (pic, id) = setup(Config {
        admin_webhook_secret: Some(secret.to_string()),
        ..Default::default()
    });

    let body = br#"{"request_id":1,"status":"approved","message":"done"}"#.to_vec();

    // No signature at all.
    let req = http_req("POST", "/webhook/admin", vec![], body.clone());
    let (resp,): (HttpResponse,) = update_candid_as(
        &pic,
        id,
        Principal::anonymous(),
        "http_request_update",
        (req,),
    )
    .unwrap();
    assert_eq!(resp.status_code, 400);

    // Correct signature, but no such AdminRequest exists yet.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(&body);
    let sig = hex::encode(mac.finalize().into_bytes());
    let req = http_req(
        "POST",
        "/webhook/admin",
        vec![("X-Signature".to_string(), format!("sha256={sig}"))],
        body,
    );
    let (resp,): (HttpResponse,) = update_candid_as(
        &pic,
        id,
        Principal::anonymous(),
        "http_request_update",
        (req,),
    )
    .unwrap();
    assert_eq!(
        resp.status_code, 400,
        "a well-signed callback for a nonexistent request id must still fail"
    );
}

// ---------------------------------------------------------------------------
// SME inbox + web channel (`chat-ui`)
// ---------------------------------------------------------------------------

fn llm_config() -> Config {
    Config {
        llm_provider: Some("openai".to_string()),
        llm_api_key: Some("sk-test".to_string()),
        ..Default::default()
    }
}

/// Submits a call that makes exactly one LLM outcall, answers it with
/// `reply`, and returns the call's raw candid reply.
fn call_with_llm_reply(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
    method: &str,
    args: Vec<u8>,
    reply: &str,
) -> Vec<u8> {
    let call_id = pic.submit_call(id, caller, method, args).unwrap();
    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    assert_eq!(requests.len(), 1, "expected one LLM outcall for {method}");
    let body =
        serde_json::json!({ "choices": [{ "message": { "content": reply, "tool_calls": [] } }] })
            .to_string();
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: requests[0].subnet_id,
        request_id: requests[0].request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 200,
            headers: vec![],
            body: body.into_bytes(),
        }),
        additional_responses: vec![],
    });
    pic.await_call(call_id).unwrap()
}

fn web_send(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
    text: &str,
    reply: &str,
) -> Result<(), String> {
    let bytes = call_with_llm_reply(
        pic,
        id,
        caller,
        "web_send",
        candid::encode_args((text,)).unwrap(),
        reply,
    );
    candid::decode_one(&bytes).unwrap()
}

fn web_send_named(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
    text: &str,
    name: Option<&str>,
    reply: &str,
) -> Result<(), String> {
    let bytes = call_with_llm_reply(
        pic,
        id,
        caller,
        "web_send",
        candid::encode_args((text, name.map(str::to_string))).unwrap(),
        reply,
    );
    candid::decode_one(&bytes).unwrap()
}

#[test]
fn web_display_name_reaches_the_inbox_and_can_be_changed_or_cleared() {
    let (pic, id) = setup(llm_config());
    let amaka = test_principal(30);
    let inbox_name = |pic: &PocketIc| {
        list_conversations(pic, id, admin()).unwrap()[0]
            .display_name
            .clone()
    };

    web_send_named(&pic, id, amaka, "hi", Some("  Amaka\n O. "), "Hello").unwrap();
    assert_eq!(inbox_name(&pic).as_deref(), Some("Amaka O."));

    // Omitted: leaves the stored name alone.
    pic.advance_time(std::time::Duration::from_secs(5));
    web_send_named(&pic, id, amaka, "again", None, "Sure").unwrap();
    assert_eq!(inbox_name(&pic).as_deref(), Some("Amaka O."));

    // Blank: clears it.
    pic.advance_time(std::time::Duration::from_secs(5));
    web_send_named(&pic, id, amaka, "bye", Some("   "), "Bye").unwrap();
    assert_eq!(inbox_name(&pic), None);
}

fn web_messages(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
) -> Result<Vec<agent::StoredChatMessage>, String> {
    let (r,): (Result<Vec<agent::StoredChatMessage>, String>,) =
        query_candid_as(pic, id, caller, "web_messages", (0u64,)).unwrap();
    r
}

fn list_conversations(
    pic: &PocketIc,
    id: Principal,
    caller: Principal,
) -> Result<Vec<agent::ConversationSummary>, String> {
    let (r,): (Result<Vec<agent::ConversationSummary>, String>,) =
        query_candid_as(pic, id, caller, "list_conversations", (0u64, 50u64)).unwrap();
    r
}

#[test]
fn web_chat_requires_an_internet_identity_caller() {
    let (pic, id) = setup(llm_config());
    let (sent,): (Result<(), String>,) =
        update_candid_as(&pic, id, Principal::anonymous(), "web_send", ("hello",)).unwrap();
    assert!(sent.unwrap_err().contains("sign in"));
    assert!(web_messages(&pic, id, Principal::anonymous())
        .unwrap_err()
        .contains("sign in"));
    let (blank,): (Result<(), String>,) =
        update_candid_as(&pic, id, test_principal(20), "web_send", ("   ",)).unwrap();
    assert!(blank.is_err());
    let long = "x".repeat(2_001);
    let (too_long,): (Result<(), String>,) =
        update_candid_as(&pic, id, test_principal(20), "web_send", (long,)).unwrap();
    assert!(too_long.is_err());
}

#[test]
fn web_chat_is_scoped_to_the_callers_principal_and_visible_in_the_sme_inbox() {
    let (pic, id) = setup(llm_config());
    let (amaka, tunde) = (test_principal(20), test_principal(21));

    web_send(
        &pic,
        id,
        amaka,
        "Do you deliver to Lekki?",
        "Yes, ₦1,000 delivery.",
    )
    .unwrap();

    let mine = web_messages(&pic, id, amaka).unwrap();
    assert_eq!(mine.len(), 2);
    assert_eq!(mine[0].content, "Do you deliver to Lekki?");
    assert_eq!(mine[1].content, "Yes, ₦1,000 delivery.");
    assert!(
        web_messages(&pic, id, tunde).unwrap().is_empty(),
        "no way to read another customer's chat"
    );

    let inbox = list_conversations(&pic, id, admin()).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].channel, Channel::Web);
    assert_eq!(inbox[0].session_id, amaka.to_text());
    assert_eq!(inbox[0].last_text, "Yes, ₦1,000 delivery.");
    assert_eq!(inbox[0].message_count, 2);

    // Inbox and raw transcripts are for the business owner only.
    assert!(list_conversations(&pic, id, amaka).is_err());
    let (transcript,): (Result<agent::ConversationState, String>,) = query_candid_as(
        &pic,
        id,
        amaka,
        "get_conversation",
        (Channel::Web, amaka.to_text()),
    )
    .unwrap();
    assert!(transcript.is_err());
}

#[test]
fn web_chat_is_rate_limited_per_customer() {
    let (pic, id) = setup(llm_config());
    let amaka = test_principal(20);
    web_send(&pic, id, amaka, "first", "ok").unwrap();
    // Immediately again: refused before any LLM call is made.
    let (second,): (Result<(), String>,) =
        update_candid_as(&pic, id, amaka, "web_send", ("second",)).unwrap();
    assert!(second.unwrap_err().contains("too quickly"));
    assert_eq!(web_messages(&pic, id, amaka).unwrap().len(), 2);
}

#[test]
fn operator_reply_is_controller_only_recorded_and_visible_to_the_customer() {
    let (pic, id) = setup(llm_config());
    let amaka = test_principal(20);
    web_send(&pic, id, amaka, "Can I change my order?", "Let me check.").unwrap();

    let reply = |caller: Principal, channel: Channel, session: String| -> Result<(), String> {
        let (r,): (Result<(), String>,) = update_candid_as(
            &pic,
            id,
            caller,
            "operator_reply",
            (channel, session, "Yes - done!"),
        )
        .unwrap();
        r
    };
    assert!(
        reply(amaka, Channel::Web, amaka.to_text()).is_err(),
        "customers cannot speak as the operator"
    );
    assert!(reply(admin(), Channel::Web, "nobody".to_string())
        .unwrap_err()
        .contains("no such conversation"));
    assert!(reply(admin(), Channel::Web, "__sme_console__".to_string()).is_err());

    reply(admin(), Channel::Web, amaka.to_text()).unwrap();
    let chat = web_messages(&pic, id, amaka).unwrap();
    assert_eq!(chat.len(), 3);
    assert_eq!(chat[2].content, "Yes - done!");
    assert!(matches!(chat[2].role, agent::Role::Operator));
    assert_eq!(
        list_conversations(&pic, id, admin()).unwrap()[0].last_text,
        "Yes - done!"
    );
}

#[test]
fn sme_console_talks_to_the_agent_privately() {
    let (pic, id) = setup(llm_config());

    let (denied,): (Result<String, String>,) =
        update_candid_as(&pic, id, test_principal(20), "console_message", ("hi",)).unwrap();
    assert!(denied.is_err(), "only a controller may use the console");

    let bytes = call_with_llm_reply(
        &pic,
        id,
        admin(),
        "console_message",
        candid::encode_args(("How many orders today?",)).unwrap(),
        "7 orders today.",
    );
    let reply: Result<String, String> = candid::decode_one(&bytes).unwrap();
    assert_eq!(reply.unwrap(), "7 orders today.");

    let (history,): (Result<agent::ConversationState, String>,) = query_candid_as(
        &pic,
        id,
        admin(),
        "get_conversation",
        (Channel::Web, "__sme_console__"),
    )
    .unwrap();
    let history = history.unwrap().history;
    assert_eq!(history.len(), 2);
    assert!(matches!(history[0].role, agent::Role::User));
    // The console is not a customer conversation.
    assert!(list_conversations(&pic, id, admin()).unwrap().is_empty());
}
