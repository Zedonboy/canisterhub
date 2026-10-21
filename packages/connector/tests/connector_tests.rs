//! PocketIC integration tests for the `connector` canister: webhook
//! signature/secret verification end to end through `http_request` /
//! `http_request_update`, `receive_mail`/`send_message`'s caller-identity
//! guards, `update_config`/`get_config`, and `send_message`'s outbound
//! HTTPS outcalls (mocked).
//!
//! Requires a built canister Wasm at
//! `../target/wasm32-unknown-unknown/release/connector.wasm` - build it first:
//!
//!   cargo build --target wasm32-unknown-unknown --release
//!   cargo test
//!
//! Uses the real PocketIC server (not a stub) - set `POCKET_IC_BIN` to a
//! local server binary to avoid a download on first run, e.g.:
//!
//!   export POCKET_IC_BIN=/path/to/pocket-ic

use candid::{encode_one, Principal};
use connector::{AuthResult, Channel, Config, ConfigUpdate, HttpRequest, HttpResponse, MailMessage, MessagePayload, OutboundMessage, StoredMessage};
use hmac::{Hmac, Mac};
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use sha2::Sha256;

const CONNECTOR_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-unknown-unknown/release/connector.wasm"));

fn test_principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn admin() -> Principal {
    test_principal(1)
}
fn mail_bridge() -> Principal {
    test_principal(2)
}
fn mallory() -> Principal {
    test_principal(3)
}
fn agent() -> Principal {
    test_principal(4)
}

fn setup(config: Config) -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let connector_id = pic.create_canister_with_settings(Some(admin()), None);
    pic.add_cycles(connector_id, 10_000_000_000_000);
    pic.install_canister(connector_id, CONNECTOR_WASM.to_vec(), encode_one(config).unwrap(), Some(admin()));
    (pic, connector_id)
}

fn http_req(method: &str, url: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> HttpRequest {
    HttpRequest { method: method.to_string(), url: url.to_string(), headers, body }
}

fn update_config(pic: &PocketIc, connector_id: Principal, caller: Principal, update: &ConfigUpdate) -> Result<(), String> {
    let (result,): (Result<(), String>,) = update_candid_as(pic, connector_id, caller, "update_config", (update.clone(),)).unwrap();
    result
}

fn get_config(pic: &PocketIc, connector_id: Principal, caller: Principal) -> Result<Config, String> {
    let (result,): (Result<Config, String>,) = query_candid_as(pic, connector_id, caller, "get_config", ()).unwrap();
    result
}

// ---------------------------------------------------------------------------
// init / update_config / get_config
// ---------------------------------------------------------------------------

#[test]
fn init_installs_the_given_config() {
    let config = Config { mail_bridge_principal: Some(mail_bridge()), ..Default::default() };
    let (pic, connector_id) = setup(config.clone());
    assert_eq!(get_config(&pic, connector_id, admin()).unwrap(), config);
}

#[test]
fn update_config_is_controller_only() {
    let (pic, connector_id) = setup(Config::default());
    let rejected = update_config(&pic, connector_id, mallory(), &ConfigUpdate { authorized_sender: Some(Some(agent())), ..Default::default() });
    assert!(rejected.is_err(), "a non-controller must not be able to update config");
}

#[test]
fn update_config_sets_only_the_named_fields_and_leaves_the_rest_untouched() {
    let (pic, connector_id) = setup(Config { mail_bridge_principal: Some(mail_bridge()), ..Default::default() });

    update_config(&pic, connector_id, admin(), &ConfigUpdate { authorized_sender: Some(Some(agent())), ..Default::default() }).unwrap();
    let config = get_config(&pic, connector_id, admin()).unwrap();
    assert_eq!(config.authorized_sender, Some(agent()));
    assert_eq!(config.mail_bridge_principal, Some(mail_bridge()), "a field not named in the update must be untouched");

    update_config(&pic, connector_id, admin(), &ConfigUpdate { whatsapp_verify_token: Some(Some("verify-me".to_string())), ..Default::default() }).unwrap();
    let config = get_config(&pic, connector_id, admin()).unwrap();
    assert_eq!(config.whatsapp_verify_token.as_deref(), Some("verify-me"));
    assert_eq!(config.authorized_sender, Some(agent()), "an earlier update's field must still be untouched by a later, unrelated update");
    assert_eq!(config.mail_bridge_principal, Some(mail_bridge()));
}

#[test]
fn update_config_some_none_clears_a_field() {
    let (pic, connector_id) = setup(Config { mail_bridge_principal: Some(mail_bridge()), ..Default::default() });
    update_config(&pic, connector_id, admin(), &ConfigUpdate { mail_bridge_principal: Some(None), ..Default::default() }).unwrap();
    assert_eq!(get_config(&pic, connector_id, admin()).unwrap().mail_bridge_principal, None);
}

#[test]
fn get_config_is_controller_only() {
    let (pic, connector_id) = setup(Config::default());
    let result = get_config(&pic, connector_id, mallory());
    assert!(result.is_err(), "a non-controller must not be able to read config");
}

// ---------------------------------------------------------------------------
// receive_mail: candid-call access control
// ---------------------------------------------------------------------------

fn sample_mail() -> MailMessage {
    MailMessage {
        envelope_from: "sender@example.com".to_string(),
        envelope_to: vec!["2vxsx-fae@mail.example.com".to_string()],
        from: "Sender <sender@example.com>".to_string(),
        to: vec!["2vxsx-fae@mail.example.com".to_string()],
        subject: "hello".to_string(),
        text_body: Some("hi there".to_string()),
        html_body: None,
        headers: vec![],
        received_at: 1_700_000_000_000_000_000,
        spf: AuthResult::Pass,
        dkim: AuthResult::Pass,
        dmarc: AuthResult::Pass,
        tls: true,
    }
}

fn call_receive_mail(pic: &PocketIc, connector_id: Principal, caller: Principal) -> Result<(), String> {
    let (result,): (Result<(), String>,) = update_candid_as(pic, connector_id, caller, "receive_mail", (sample_mail(),)).unwrap();
    result
}

#[test]
fn receive_mail_rejects_until_mail_bridge_principal_is_configured() {
    let (pic, connector_id) = setup(Config::default());
    assert!(call_receive_mail(&pic, connector_id, mail_bridge()).is_err());
}

#[test]
fn receive_mail_rejects_anonymous_and_wrong_callers() {
    let (pic, connector_id) = setup(Config { mail_bridge_principal: Some(mail_bridge()), ..Default::default() });
    assert!(call_receive_mail(&pic, connector_id, Principal::anonymous()).is_err(), "anonymous caller must be rejected");
    assert!(call_receive_mail(&pic, connector_id, mallory()).is_err(), "a caller that isn't the configured mail bridge must be rejected");
}

#[test]
fn receive_mail_accepts_the_configured_bridge_and_a_controller() {
    let (pic, connector_id) = setup(Config { mail_bridge_principal: Some(mail_bridge()), ..Default::default() });
    assert!(call_receive_mail(&pic, connector_id, mail_bridge()).is_ok());
    assert!(call_receive_mail(&pic, connector_id, admin()).is_ok(), "a controller should be able to call receive_mail too");

    let (stored,): (Result<Vec<StoredMessage>, String>,) = query_candid_as(&pic, connector_id, admin(), "list_messages", (0u64, 10u64)).unwrap();
    let stored = stored.unwrap();
    assert_eq!(stored.len(), 2);
    assert!(matches!(&stored[0].payload, MessagePayload::Mail(_)));
}

// ---------------------------------------------------------------------------
// list_messages / get_message: controller-only reads
// ---------------------------------------------------------------------------

#[test]
fn message_queries_are_controller_only() {
    let (pic, connector_id) = setup(Config::default());
    let (result,): (Result<Vec<StoredMessage>, String>,) = query_candid_as(&pic, connector_id, mallory(), "list_messages", (0u64, 10u64)).unwrap();
    assert!(result.is_err(), "a non-controller must not be able to list messages");

    let (result,): (Result<Option<StoredMessage>, String>,) = query_candid_as(&pic, connector_id, mallory(), "get_message", (0u64,)).unwrap();
    assert!(result.is_err(), "a non-controller must not be able to read a message");
}

// ---------------------------------------------------------------------------
// WhatsApp webhook, end to end through http_request/http_request_update
// ---------------------------------------------------------------------------

fn http_request_call(pic: &PocketIc, connector_id: Principal, req: &HttpRequest) -> HttpResponse {
    let (resp,): (HttpResponse,) = query_candid_as(pic, connector_id, Principal::anonymous(), "http_request", (req.clone(),)).unwrap();
    resp
}

fn http_request_update_call(pic: &PocketIc, connector_id: Principal, req: &HttpRequest) -> HttpResponse {
    let (resp,): (HttpResponse,) = update_candid_as(pic, connector_id, Principal::anonymous(), "http_request_update", (req.clone(),)).unwrap();
    resp
}

#[test]
fn whatsapp_get_handshake_echoes_challenge() {
    let (pic, connector_id) = setup(Config { whatsapp_verify_token: Some("verify-me".to_string()), ..Default::default() });
    let req = http_req("GET", "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=999", vec![], vec![]);
    let resp = http_request_call(&pic, connector_id, &req);
    assert_eq!(resp.status_code, 200);
    assert_eq!(String::from_utf8(resp.body).unwrap(), "999");
}

#[test]
fn whatsapp_get_handshake_rejects_wrong_token() {
    let (pic, connector_id) = setup(Config { whatsapp_verify_token: Some("verify-me".to_string()), ..Default::default() });
    let req = http_req("GET", "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=999", vec![], vec![]);
    assert_eq!(http_request_call(&pic, connector_id, &req).status_code, 403);
}

#[test]
fn whatsapp_post_upgrades_to_update_call() {
    let (pic, connector_id) = setup(Config::default());
    let req = http_req("POST", "/webhook/whatsapp", vec![], b"{}".to_vec());
    let resp = http_request_call(&pic, connector_id, &req);
    assert_eq!(resp.upgrade, Some(true), "a webhook POST must upgrade to an update call, not be handled in the query");
}

#[test]
fn whatsapp_post_rejects_bad_signature_and_accepts_correct_one() {
    let secret = "app-secret";
    let (pic, connector_id) = setup(Config { whatsapp_app_secret: Some(secret.to_string()), ..Default::default() });

    let body = whatsapp_payload("wamid.1", "15557654321", "15551234567", "hello");

    let bad_req = http_req("POST", "/webhook/whatsapp", vec![("X-Hub-Signature-256".to_string(), "sha256=deadbeef".to_string())], body.clone());
    assert_eq!(http_request_update_call(&pic, connector_id, &bad_req).status_code, 401);

    let sig = hmac_sha256_hex(secret, &body);
    let good_req = http_req("POST", "/webhook/whatsapp", vec![("X-Hub-Signature-256".to_string(), format!("sha256={sig}"))], body);
    assert_eq!(http_request_update_call(&pic, connector_id, &good_req).status_code, 200);

    let (stored,): (Result<Vec<StoredMessage>, String>,) = query_candid_as(&pic, connector_id, admin(), "list_messages", (0u64, 10u64)).unwrap();
    let stored = stored.unwrap();
    assert_eq!(stored.len(), 1);
    match &stored[0].payload {
        MessagePayload::WhatsApp(m) => {
            assert_eq!(m.message_id, "wamid.1");
            assert_eq!(m.from, "15557654321");
            assert_eq!(m.text.as_deref(), Some("hello"));
        }
        other => panic!("expected a WhatsApp payload, got {other:?}"),
    }
}

fn whatsapp_payload(message_id: &str, from: &str, display_number: &str, text: &str) -> Vec<u8> {
    serde_json::json!({
        "entry": [{
            "changes": [{
                "value": {
                    "metadata": { "display_phone_number": display_number },
                    "messages": [{ "id": message_id, "from": from, "type": "text", "text": { "body": text } }]
                }
            }]
        }]
    })
    .to_string()
    .into_bytes()
}

fn hmac_sha256_hex(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

// ---------------------------------------------------------------------------
// Telegram webhook, end to end through http_request/http_request_update
// ---------------------------------------------------------------------------

#[test]
fn telegram_post_rejects_missing_secret_and_accepts_correct_one() {
    let secret = "telegram-secret";
    let (pic, connector_id) = setup(Config { telegram_secret_token: Some(secret.to_string()), ..Default::default() });

    let body = serde_json::json!({
        "update_id": 1,
        "message": { "message_id": 5, "date": 1700000000, "chat": { "id": 42 }, "from": { "id": 7, "username": "bob" }, "text": "hi" }
    })
    .to_string()
    .into_bytes();

    let no_secret_req = http_req("POST", "/webhook/telegram", vec![], body.clone());
    assert_eq!(http_request_update_call(&pic, connector_id, &no_secret_req).status_code, 401);

    let good_req = http_req("POST", "/webhook/telegram", vec![("X-Telegram-Bot-Api-Secret-Token".to_string(), secret.to_string())], body);
    assert_eq!(http_request_update_call(&pic, connector_id, &good_req).status_code, 200);

    let (stored,): (Result<Vec<StoredMessage>, String>,) = query_candid_as(&pic, connector_id, admin(), "list_messages", (0u64, 10u64)).unwrap();
    let stored = stored.unwrap();
    assert_eq!(stored.len(), 1);
    match &stored[0].payload {
        MessagePayload::Telegram(m) => {
            assert_eq!(m.chat_id, 42);
            assert_eq!(m.text.as_deref(), Some("hi"));
        }
        other => panic!("expected a Telegram payload, got {other:?}"),
    }
}

#[test]
fn unknown_http_paths_404() {
    let (pic, connector_id) = setup(Config::default());
    let req = http_req("GET", "/not-a-real-path", vec![], vec![]);
    assert_eq!(http_request_call(&pic, connector_id, &req).status_code, 404);
}

// ---------------------------------------------------------------------------
// send_message: access control + outbound outcalls (mocked)
// ---------------------------------------------------------------------------

fn outbound_whatsapp() -> OutboundMessage {
    OutboundMessage { channel: Channel::WhatsApp, session_id: "15557654321".to_string(), text: "hello back".to_string(), subject: None }
}

#[test]
fn send_message_rejects_anonymous_wrong_and_unconfigured_callers() {
    let (pic, connector_id) = setup(Config::default());
    let (result,): (Result<(), String>,) = update_candid_as(&pic, connector_id, agent(), "send_message", (outbound_whatsapp(),)).unwrap();
    assert!(result.is_err(), "authorized_sender is not configured, so no caller should be accepted");

    let (pic, connector_id) = setup(Config { authorized_sender: Some(agent()), ..Default::default() });
    let (anon,): (Result<(), String>,) = update_candid_as(&pic, connector_id, Principal::anonymous(), "send_message", (outbound_whatsapp(),)).unwrap();
    assert!(anon.is_err());
    let (wrong,): (Result<(), String>,) = update_candid_as(&pic, connector_id, mallory(), "send_message", (outbound_whatsapp(),)).unwrap();
    assert!(wrong.is_err());
}

/// Submits `send_message`, waits for the resulting HTTPS outcall, mocks a
/// `200` JSON response for it, and returns the call's final result -
/// mirrors `backend/tests/marketplace_tests.rs`'s
/// `call_with_mocked_github_response` helper.
fn send_message_with_mocked_response(pic: &PocketIc, connector_id: Principal, caller: Principal, msg: OutboundMessage, mock_status: u16, mock_body: &[u8]) -> Result<(), String> {
    let payload = candid::encode_args((msg,)).unwrap();
    let call_id = pic.submit_call(connector_id, caller, "send_message", payload).unwrap();

    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    assert_eq!(requests.len(), 1, "expected exactly one pending HTTPS outcall from send_message");
    let request = &requests[0];

    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: request.subnet_id,
        request_id: request.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply { status: mock_status, headers: vec![], body: mock_body.to_vec() }),
        additional_responses: vec![],
    });

    let reply = pic.await_call(call_id).unwrap();
    let (result,): (Result<(), String>,) = candid::decode_args(&reply).unwrap();
    result
}

#[test]
fn send_message_whatsapp_requires_config_and_succeeds_when_configured() {
    let (pic, connector_id) = setup(Config { authorized_sender: Some(agent()), ..Default::default() });
    let (result,): (Result<(), String>,) = update_candid_as(&pic, connector_id, agent(), "send_message", (outbound_whatsapp(),)).unwrap();
    assert!(result.is_err(), "should fail before whatsapp_access_token/phone_number_id are configured");

    let update = ConfigUpdate {
        whatsapp_access_token: Some(Some("wa-token".to_string())),
        whatsapp_phone_number_id: Some(Some("1234567890".to_string())),
        ..Default::default()
    };
    update_config(&pic, connector_id, admin(), &update).unwrap();

    let result = send_message_with_mocked_response(&pic, connector_id, agent(), outbound_whatsapp(), 200, br#"{"messages":[{"id":"wamid.out.1"}]}"#);
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn send_message_telegram_rejects_non_integer_session_id() {
    let (pic, connector_id) = setup(Config {
        authorized_sender: Some(agent()),
        telegram_bot_token: Some("tg-token".to_string()),
        ..Default::default()
    });
    let msg = OutboundMessage { channel: Channel::Telegram, session_id: "not-a-chat-id".to_string(), text: "hi".to_string(), subject: None };
    let (result,): (Result<(), String>,) = update_candid_as(&pic, connector_id, agent(), "send_message", (msg,)).unwrap();
    assert!(result.is_err());
}

#[test]
fn send_message_telegram_succeeds_when_configured() {
    let (pic, connector_id) = setup(Config {
        authorized_sender: Some(agent()),
        telegram_bot_token: Some("tg-token".to_string()),
        ..Default::default()
    });
    let msg = OutboundMessage { channel: Channel::Telegram, session_id: "42".to_string(), text: "hi".to_string(), subject: None };
    let result = send_message_with_mocked_response(&pic, connector_id, agent(), msg, 200, br#"{"ok":true}"#);
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn send_message_email_succeeds_when_configured_and_surfaces_relay_errors() {
    let (pic, connector_id) = setup(Config {
        authorized_sender: Some(agent()),
        mail_bridge_url: Some("https://mail-bridge.example.com".to_string()),
        mail_bridge_api_key: Some("bridge-key".to_string()),
        mail_from_address: Some("bot@example.com".to_string()),
        ..Default::default()
    });
    let msg = OutboundMessage { channel: Channel::Email, session_id: "someone@example.com".to_string(), text: "hi".to_string(), subject: Some("Reply".to_string()) };

    let result = send_message_with_mocked_response(&pic, connector_id, agent(), msg.clone(), 200, br#"{"success":true}"#);
    assert!(result.is_ok(), "{result:?}");

    let result = send_message_with_mocked_response(&pic, connector_id, agent(), msg, 502, br#"{"success":false,"error":"relay down"}"#);
    assert!(result.is_err(), "a non-200 from mail_bridge should surface as an error");
}

// ---------------------------------------------------------------------------
// llm_context: open to any caller
// ---------------------------------------------------------------------------

#[test]
fn llm_context_is_readable_by_anyone_and_mentions_every_method() {
    let (pic, connector_id) = setup(Config::default());
    let (doc,): (String,) = query_candid_as(&pic, connector_id, Principal::anonymous(), "llm_context", ()).unwrap();
    for method in ["receive_mail", "send_message", "http_request", "update_config", "get_config", "list_messages", "get_message", "llm_context"] {
        assert!(doc.contains(method), "llm_context should mention `{method}`");
    }
}
