//! Fused messaging gateway and LLM agent. WhatsApp, Telegram, and mail
//! ingress is authenticated here, persisted here, processed through the LLM
//! here, and replied to from this same canister. Business canisters are
//! discovered through `llm_context` and invoked only through validated
//! `ai_*` methods with an agent-derived `AiContext`.
//!
//! Controller-only configuration and registry methods protect credentials
//! and tool selection. A per-session guard spans every await in one turn so
//! concurrent messages cannot interleave the same conversation's state.

// Keep the dependency version selected by the packages workspace while
// exposing the canonical crate name expected by ic-cdk's procedural macros.
extern crate ic_cdk_020 as ic_cdk;

mod admin;
mod assets;
mod config;
mod dynamic_config;
mod http;
mod llm;
mod messages;
mod outbound;
mod owner_tools;
mod protocol;
mod remote_tools;
mod state;
mod telegram;
mod tools;
mod whatsapp;

// Re-exported so integration tests (`tests/agent_tests.rs`) can
// encode/decode candid calls against real Rust types instead of hand-
// building candid values.
pub use config::{Config, ConfigUpdate, ProjectCanister, ProjectContext};
pub use http::{HttpRequest, HttpResponse};
pub use messages::{
    AdminRequest, AdminRequestStatus, AgentStats, AiCanister, AiContext, AiMethod, AuthResult,
    BusinessMessage, Channel, ClientDataKind, ClientDataRequest, ClientDataValue,
    ConversationState, ConversationSummary, IncomingMessage, MailMessage, MessagePayload,
    OutboundMessage, Role, StoredChatMessage, StoredMessage, TelegramMessage, WhatsAppMessage,
};

use candid::Principal;
use dynamic_config::{CanisterLink, ConfigFieldSchema, ConfigValue};
use messages::{SessionKey, CONSOLE_SESSION};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

pub(crate) fn log_info(message: impl AsRef<str>) {
    ic_cdk::api::debug_print(format!("[agent][INFO] {}", message.as_ref()));
}

pub(crate) fn log_warn(message: impl AsRef<str>) {
    ic_cdk::api::debug_print(format!("[agent][WARN] {}", message.as_ref()));
}

pub(crate) fn log_error(message: impl AsRef<str>) {
    ic_cdk::api::debug_print(format!("[agent][ERROR] {}", message.as_ref()));
}

thread_local! {
    static PENDING_SESSIONS: RefCell<BTreeSet<SessionKey>> = const { RefCell::new(BTreeSet::new()) };
}

/// Per-conversation reentrancy lock - see this module's doc comment for why
/// it's keyed by `SessionKey` rather than caller, and the `canister-security`
/// skill for the general pattern this adapts (held across every `await` in
/// `receive_message` via the `_guard` binding - see its doc comment on why
/// the binding must not be `_`).
struct SessionGuard(SessionKey);

impl SessionGuard {
    fn new(key: SessionKey) -> Result<Self, String> {
        PENDING_SESSIONS.with(|p| {
            if !p.borrow_mut().insert(key.clone()) {
                return Err(
                    "already processing a message for this conversation - try again shortly"
                        .to_string(),
                );
            }
            Ok(Self(key))
        })
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        PENDING_SESSIONS.with(|p| {
            p.borrow_mut().remove(&self.0);
        });
    }
}

fn require_controller() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        log_warn("controller-only call rejected");
        Err("only a controller may call this method".to_string())
    }
}

/// A controller may always call `receive_message`, in addition to whichever
/// principal `expected` names - useful for testing and manual intervention
/// without impersonating `connector`'s identity.
fn require_authorized(
    caller: Principal,
    expected: Option<Principal>,
    role: &str,
) -> Result<(), String> {
    if caller == Principal::anonymous() {
        return Err("anonymous caller not allowed".to_string());
    }
    if ic_cdk::api::is_controller(&caller) {
        return Ok(());
    }
    match expected {
        None => Err(format!(
            "{role} is not configured - a controller must call update_config first"
        )),
        Some(expected) if expected == caller => Ok(()),
        Some(_) => Err(format!("caller is not the configured {role}")),
    }
}

#[ic_cdk::init]
fn init(project_context: ProjectContext) {
    let context_canisters = project_context.canisters.len();
    let config =
        dynamic_config::prefill_from_project_context(Config::default(), Some(&project_context));
    let provider = config.llm_provider.as_deref().unwrap_or("managed");
    log_info(format!(
        "initializing provider={provider} project_configured={} context_canisters={context_canisters}",
        config.project_id.is_some()
    ));
    state::set_config(config);
    assets::certify();
    log_info("initialization complete; certified assets ready");
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    assets::certify();
    log_info("post-upgrade recovery complete; certified assets refreshed");
}

// ---------------------------------------------------------------------------
// receive_message (controller-driven testing/manual ingress)
// ---------------------------------------------------------------------------

/// Runs one controller-submitted message through the same path used by the
/// channel webhooks. Real channel ingress calls `process_message` internally.
#[ic_cdk::update]
async fn receive_message(msg: IncomingMessage) -> Result<(), String> {
    require_controller()?;
    process_message(msg).await
}

async fn process_message(msg: IncomingMessage) -> Result<(), String> {
    process_message_with_client_data(msg, None).await
}

async fn process_message_with_client_data(
    mut msg: IncomingMessage,
    client_data: Option<(Option<u64>, ClientDataValue)>,
) -> Result<(), String> {
    let config = state::get_config();
    let customer = SessionKey::from(&msg);
    log_info(format!(
        "message processing started channel={:?} input_chars={} client_data={}",
        customer.channel,
        msg.text.chars().count(),
        client_data.is_some()
    ));
    // Held for the rest of this function - see `SessionGuard`'s doc comment.
    let _guard = SessionGuard::new(customer.clone())?;
    if let Some((request_id, value)) = client_data {
        // Native clients may share a location spontaneously. Treat it as an
        // ordinary structured message when nothing is pending; when a request
        // is pending, validate and consume that exact request.
        if request_id.is_some() || state::get_client_data_request(&customer).is_some() {
            let (_request, text) = state::consume_client_data(&customer, request_id, &value)?;
            msg.text = text;
        }
    } else if state::get_client_data_request(&customer)
        .is_some_and(|request| request.kind == ClientDataKind::Location)
    {
        if let Some(value) = ClientDataValue::parse_location_text(&msg.text) {
            let (_request, text) = state::consume_client_data(&customer, None, &value)?;
            msg.text = text;
        }
    } else {
        state::consume_typed_client_data(&customer, &msg.text);
    }
    let notification_preview = msg.text.clone();

    let history = state::get_conversation(&customer).to_rig_history();
    let history_messages = history.len();
    let reply_text = llm::run_agent_loop(&customer, &config, history, &msg.text).await;
    state::record_turn();

    // Appended to the conversation as it is *now*, not as it was before the
    // model call: an operator may have replied while the model was thinking.
    let now = ic_cdk::api::time();
    state::append_messages(
        &customer,
        vec![
            StoredChatMessage {
                role: Role::User,
                content: msg.text,
                at: now,
            },
            StoredChatMessage {
                role: Role::Assistant,
                content: reply_text.clone(),
                at: now,
            },
        ],
    );

    if customer.session_id != CONSOLE_SESSION {
        protocol::notify_owner(
            &config,
            "New customer message",
            &notification_preview,
            "/inbox",
        )
        .await;
    }

    outbound::reply_to_customer(&config, &customer, &reply_text).await?;
    if let Some(request) = state::get_client_data_request(&customer) {
        outbound::send_client_data_request(&config, &customer, &request).await?;
    }
    log_info(format!(
        "message processing completed channel={:?} history_messages={history_messages} reply_chars={}",
        customer.channel,
        reply_text.chars().count()
    ));
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP webhook (administrative callback only - see admin.rs)
// ---------------------------------------------------------------------------

const ADMIN_WEBHOOK_PATH: &str = "/webhook/admin";
const WHATSAPP_PATH: &str = "/webhook/whatsapp";
const TELEGRAM_PATH: &str = "/webhook/telegram";

/// First stop for every inbound HTTP request (a query call - see
/// `connector/src/http.rs`'s doc comment for the full explanation of the
/// IC's `http_request`/`http_request_update` split). This canister has
/// exactly one HTTP endpoint, and it always mutates state (updates an
/// `AdminRequest`, and typically triggers a reply to the customer) - so it
/// always upgrades, never handled here.
#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    match (req.method.as_str(), path) {
        ("GET", WHATSAPP_PATH) => match state::get_config().whatsapp_verify_token {
            Some(token) => whatsapp::verify_handshake(&req, &token),
            None => HttpResponse::text(503, "whatsapp_verify_token is not configured"),
        },
        ("POST", ADMIN_WEBHOOK_PATH | WHATSAPP_PATH | TELEGRAM_PATH) => {
            HttpResponse::upgrade_to_update()
        }
        ("GET" | "HEAD", _) => assets::serve(&req),
        _ => HttpResponse::not_found(),
    }
}

/// Verifies and applies an administrative resolution (see
/// `admin::handle_callback`), then relays its `result_message` to the
/// customer through this canister's outbound channel implementation,
/// independently of and without re-invoking the LLM.
#[ic_cdk::update]
async fn http_request_update(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    log_info(format!(
        "webhook update received method={} path={path}",
        req.method
    ));
    match (req.method.as_str(), path) {
        ("POST", ADMIN_WEBHOOK_PATH) => handle_admin_callback(&req).await,
        ("POST", WHATSAPP_PATH) => handle_whatsapp(&req),
        ("POST", TELEGRAM_PATH) => handle_telegram(&req),
        _ => HttpResponse::not_found(),
    }
}

async fn handle_admin_callback(req: &HttpRequest) -> HttpResponse {
    let signature = http::header(&req.headers, "X-Signature");
    let updated = match admin::handle_callback(&req.body, signature) {
        Ok(updated) => updated,
        Err(e) => return HttpResponse::text(400, e),
    };

    if let Some(message) = &updated.result_message {
        let customer = SessionKey {
            channel: updated.channel,
            session_id: updated.session_id.clone(),
        };
        if let Err(e) = outbound::reply_to_customer(&state::get_config(), &customer, message).await
        {
            log_error(format!(
                "failed to relay admin callback #{} to customer: {e}",
                updated.id
            ));
        }
    }
    HttpResponse::text(200, "ok")
}

fn store_and_process(payload: MessagePayload) {
    let message = state::insert_message(payload);
    log_info(format!("inbound message stored id={}", message.id));
    if let Some(incoming) = message.payload.incoming() {
        let client_data = message.payload.client_data().map(|value| (None, value));
        ic_cdk::futures::spawn(async move {
            if let Err(e) = process_message_with_client_data(incoming, client_data).await {
                log_error(format!("inbound message processing failed: {e}"));
            }
        });
    }
}

fn handle_whatsapp(req: &HttpRequest) -> HttpResponse {
    let Some(secret) = state::get_config().whatsapp_app_secret else {
        return HttpResponse::text(503, "whatsapp_app_secret is not configured");
    };
    if !whatsapp::verify_signature(&req.body, whatsapp::header_signature(req), &secret) {
        log_warn("WhatsApp webhook rejected: invalid signature");
        return HttpResponse::text(401, "invalid signature");
    }
    match whatsapp::parse_messages(&req.body) {
        Ok(messages) => {
            log_info(format!(
                "WhatsApp webhook accepted messages={}",
                messages.len()
            ));
            for message in messages {
                store_and_process(MessagePayload::WhatsApp(message));
            }
            HttpResponse::text(200, "ok")
        }
        Err(e) => HttpResponse::text(400, e),
    }
}

fn handle_telegram(req: &HttpRequest) -> HttpResponse {
    let Some(secret) = state::get_config().telegram_secret_token else {
        return HttpResponse::text(503, "telegram_secret_token is not configured");
    };
    if !telegram::verify_secret(req, &secret) {
        log_warn("Telegram webhook rejected: invalid secret token");
        return HttpResponse::text(401, "invalid secret token");
    }
    match telegram::parse_update(&req.body) {
        Ok(Some(message)) => {
            log_info("Telegram webhook accepted one message");
            store_and_process(MessagePayload::Telegram(message));
            HttpResponse::text(200, "ok")
        }
        Ok(None) => HttpResponse::text(200, "ok"),
        Err(e) => HttpResponse::text(400, e),
    }
}

#[ic_cdk::update]
fn receive_mail(mail: MailMessage) -> Result<(), String> {
    require_authorized(
        ic_cdk::api::msg_caller(),
        state::get_config().mail_bridge_principal,
        "mail bridge",
    )?;
    log_info("mail bridge message accepted");
    store_and_process(MessagePayload::Mail(mail));
    Ok(())
}

#[ic_cdk::update]
async fn send_message(message: BusinessMessage) -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    let config = state::get_config();
    if caller == Principal::anonymous()
        || (!ic_cdk::api::is_controller(&caller)
            && config.inventory_canister_id != Some(caller)
            && config.restaurant_canister_id != Some(caller))
    {
        return Err("send_message is restricted to controllers and configured inventory or restaurant packages".to_string());
    }
    if message.session_id.trim().is_empty() || message.session_id.len() > 512 {
        return Err("invalid customer session".to_string());
    }
    validate_chat_text(&message.text)?;
    let channel = state::resolve_channel_for_session(&message.session_id)?;
    if channel == Channel::Web {
        let principal = Principal::from_text(&message.session_id)
            .map_err(|_| "web session_id must be a customer principal".to_string())?;
        if principal == Principal::anonymous() || message.session_id == CONSOLE_SESSION {
            return Err("invalid web customer session".to_string());
        }
    }

    let routed_message = OutboundMessage {
        channel,
        session_id: message.session_id,
        text: message.text,
        subject: message.subject,
    };
    outbound::send(&config, &routed_message).await?;
    let customer = SessionKey {
        channel,
        session_id: routed_message.session_id,
    };
    state::append_messages(
        &customer,
        vec![StoredChatMessage {
            role: Role::Assistant,
            content: routed_message.text,
            at: ic_cdk::api::time(),
        }],
    );
    log_info(format!(
        "business package message delivered caller={caller} channel={channel:?}",
    ));
    Ok(())
}

/// Refreshes the project inventory identity used by the package-to-agent
/// customer messaging boundary. The dashboard calls this after project
/// canisters change; only a controller may replace the trusted package ID.
#[ic_cdk::update]
fn update_project_context(context: ProjectContext) -> Result<(), String> {
    require_controller()?;
    let mut config = state::get_config();
    config.inventory_canister_id = context.canister_for_package("order_inventory.wasm");
    config.restaurant_canister_id = context.canister_for_package("restaurant.wasm");
    state::set_config(config);
    log_info(format!(
        "project context refreshed inventory_configured={}",
        state::get_config().inventory_canister_id.is_some()
    ));
    Ok(())
}

// ---------------------------------------------------------------------------
// SME inbox + web channel (`chat-ui`)
// ---------------------------------------------------------------------------

/// Longest message either side may send through the chat UI, in characters.
const MAX_CHAT_CHARS: usize = 2_000;
/// Per-customer pacing for `web_send`: each turn can cost an LLM outcall, and
/// Internet Identity principals are free to mint, so a floor on spacing plus a
/// daily cap keeps one client from burning the owner's LLM budget. Heap state
/// (reset on upgrade) - fine for rate limiting.
const WEB_MIN_GAP_NS: u64 = 3_000_000_000;
const WEB_DAY_NS: u64 = 86_400_000_000_000;
const WEB_MAX_PER_DAY: usize = 200;

thread_local! {
    static WEB_SENDS: RefCell<HashMap<Principal, Vec<u64>>> = RefCell::new(HashMap::new());
}

fn validate_chat_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("message is empty".to_string());
    }
    if text.chars().count() > MAX_CHAT_CHARS {
        return Err(format!(
            "message is longer than {MAX_CHAT_CHARS} characters"
        ));
    }
    Ok(())
}

const MAX_DISPLAY_NAME_CHARS: usize = 40;

/// Trims, drops control characters and caps the length; `None` if nothing is left.
fn clean_display_name(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let cleaned: String = cleaned
        .trim()
        .chars()
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod display_name_tests {
    use super::*;

    #[test]
    fn display_names_are_cleaned() {
        assert_eq!(clean_display_name("  Amaka  "), Some("Amaka".to_string()));
        assert_eq!(
            clean_display_name("Am\naka\u{0}"),
            Some("Amaka".to_string())
        );
        assert_eq!(clean_display_name("   "), None);
        assert_eq!(
            clean_display_name(&"x".repeat(100))
                .unwrap()
                .chars()
                .count(),
            40
        );
    }
}

fn require_signed_in() -> Result<Principal, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err("sign in with Internet Identity to chat".to_string());
    }
    Ok(caller)
}

fn web_session(caller: Principal) -> SessionKey {
    SessionKey {
        channel: Channel::Web,
        session_id: caller.to_text(),
    }
}

/// Records this send against `caller`, or says why it is refused.
fn check_web_rate_limit(caller: Principal, now: u64) -> Result<(), String> {
    WEB_SENDS.with(|sends| {
        let mut sends = sends.borrow_mut();
        let times = sends.entry(caller).or_default();
        times.retain(|t| now.saturating_sub(*t) < WEB_DAY_NS);
        if times
            .last()
            .is_some_and(|last| now.saturating_sub(*last) < WEB_MIN_GAP_NS)
        {
            return Err("you're sending messages too quickly - wait a moment".to_string());
        }
        if times.len() >= WEB_MAX_PER_DAY {
            return Err("daily message limit reached - try again tomorrow".to_string());
        }
        times.push(now);
        if sends.len() > 10_000 {
            sends.retain(|_, t| {
                t.last()
                    .is_some_and(|l| now.saturating_sub(*l) < WEB_DAY_NS)
            });
        }
        Ok(())
    })
}

/// SME inbox: all customer conversations across channels, newest first
/// (the private agent console is excluded).
#[ic_cdk::query]
fn list_conversations(offset: u64, limit: u64) -> Result<Vec<ConversationSummary>, String> {
    require_controller()?;
    Ok(state::list_conversation_summaries(offset, limit.min(200)))
}

/// The business owner replies to a customer as themselves: delivered over the
/// conversation's own channel (nothing to deliver for `Web`), then recorded as
/// an `Operator` turn so it appears in the transcript and the agent knows a
/// human spoke.
#[ic_cdk::update]
async fn operator_reply(channel: Channel, session_id: String, text: String) -> Result<(), String> {
    require_controller()?;
    validate_chat_text(&text)?;
    if channel == Channel::Web && session_id == CONSOLE_SESSION {
        return Err("the agent console is not a customer conversation".to_string());
    }
    let key = SessionKey {
        channel,
        session_id,
    };
    if state::get_conversation(&key).history.is_empty() {
        return Err("no such conversation".to_string());
    }
    outbound::send(
        &state::get_config(),
        &OutboundMessage {
            channel: key.channel,
            session_id: key.session_id.clone(),
            text: text.clone(),
            subject: None,
        },
    )
    .await?;
    state::append_messages(
        &key,
        vec![StoredChatMessage {
            role: Role::Operator,
            content: text.clone(),
            at: ic_cdk::api::time(),
        }],
    );
    log_info(format!("operator reply delivered channel={channel:?}"));
    Ok(())
}

/// The SME talks to the agent itself. Runs the normal agent loop under the
/// reserved console session and returns the reply; nothing is sent to any
/// customer. The SME's own turns are stored as `User`.
#[ic_cdk::update]
async fn console_message(text: String) -> Result<String, String> {
    require_controller()?;
    validate_chat_text(&text)?;
    log_info(format!(
        "owner console message accepted chars={}",
        text.chars().count()
    ));
    let key = SessionKey {
        channel: Channel::Web,
        session_id: CONSOLE_SESSION.to_string(),
    };
    process_message(IncomingMessage {
        channel: key.channel,
        session_id: key.session_id.clone(),
        text,
    })
    .await?;
    state::get_conversation(&key)
        .history
        .last()
        .map(|m| m.content.clone())
        .ok_or_else(|| "the agent produced no reply".to_string())
}

/// A customer's message on the web channel. The conversation is the caller's
/// own principal - there is no session argument, so nobody can write into or
/// read someone else's chat. Resolves after the agent's reply is stored.
///
/// `display_name` is the optional label the customer chose in their browser
/// (it lives there; this only keeps a copy so the inbox can show it). `None`
/// leaves the stored label alone, an empty or whitespace-only value clears it.
/// It is self-declared, so it is cleaned up but never trusted as identity.
#[ic_cdk::update]
async fn web_send(text: String, display_name: Option<String>) -> Result<(), String> {
    let caller = require_signed_in()?;
    validate_chat_text(&text)?;
    check_web_rate_limit(caller, ic_cdk::api::time())?;
    log_info(format!(
        "web message accepted chars={}",
        text.chars().count()
    ));
    let key = web_session(caller);
    if let Some(name) = display_name {
        let mut profile = state::get_customer_profile(&key);
        profile.display_name = clean_display_name(&name);
        state::set_customer_profile(&key, profile);
    }
    process_message(IncomingMessage {
        channel: key.channel,
        session_id: key.session_id,
        text,
    })
    .await
}

/// The current web customer's pending client-side request, if the model has
/// asked the browser to collect one. It is keyed by the caller's principal;
/// callers cannot inspect another customer's request.
#[ic_cdk::query]
fn web_pending_client_data() -> Result<Option<ClientDataRequest>, String> {
    let caller = require_signed_in()?;
    Ok(state::get_client_data_request(&web_session(caller)))
}

/// Supplies a value collected by the web client, then runs it through the
/// normal agent loop as the customer's next turn. The request id prevents a
/// stale browser control from answering a newer request.
#[ic_cdk::update]
async fn web_submit_client_data(
    request_id: u64,
    value: ClientDataValue,
    display_name: Option<String>,
) -> Result<(), String> {
    let caller = require_signed_in()?;
    check_web_rate_limit(caller, ic_cdk::api::time())?;
    log_info(format!("web client data submitted request_id={request_id}"));
    let key = web_session(caller);
    if let Some(name) = display_name {
        let mut profile = state::get_customer_profile(&key);
        profile.display_name = clean_display_name(&name);
        state::set_customer_profile(&key, profile);
    }
    process_message_with_client_data(
        IncomingMessage {
            channel: key.channel,
            session_id: key.session_id,
            text: String::new(),
        },
        Some((Some(request_id), value)),
    )
    .await
}

/// The caller's own web conversation from index `after` onward.
#[ic_cdk::query]
fn web_messages(after: u64) -> Result<Vec<StoredChatMessage>, String> {
    let caller = require_signed_in()?;
    Ok(state::get_conversation(&web_session(caller))
        .history
        .into_iter()
        .skip(after as usize)
        .collect())
}

// ---------------------------------------------------------------------------
// Configuration (controller-only)
// ---------------------------------------------------------------------------

#[ic_cdk::update]
fn update_config(update: ConfigUpdate) -> Result<(), String> {
    require_controller()?;
    state::set_config(state::get_config().apply(update));
    assets::certify();
    log_info("legacy runtime configuration updated");
    Ok(())
}

#[ic_cdk::query]
fn get_runtime_config() -> Result<Config, String> {
    require_controller()?;
    Ok(state::get_config())
}

// ---------------------------------------------------------------------------
// Observability (controller-only)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_conversation(channel: Channel, session_id: String) -> Result<ConversationState, String> {
    require_controller()?;
    Ok(state::get_conversation(&SessionKey {
        channel,
        session_id,
    }))
}

#[ic_cdk::query]
fn get_admin_request(id: u64) -> Result<Option<AdminRequest>, String> {
    require_controller()?;
    Ok(state::get_admin_request(id))
}

/// Newest-first, paginated via `offset`/`limit`.
#[ic_cdk::query]
fn list_admin_requests(offset: u64, limit: u64) -> Result<Vec<AdminRequest>, String> {
    require_controller()?;
    Ok(state::list_admin_requests(offset, limit))
}

/// Mark a human-handled ticket as completed.
#[ic_cdk::update]
fn complete_admin_request(id: u64) -> Result<AdminRequest, String> {
    require_controller()?;
    state::update_admin_request(id, |request| {
        request.status = AdminRequestStatus::Completed;
        request.updated_at = ic_cdk::api::time();
    })?;
    state::get_admin_request(id).ok_or_else(|| format!("ticket #{id} was not found after update"))
}

#[ic_cdk::query]
fn get_message(id: u64) -> Result<Option<StoredMessage>, String> {
    require_controller()?;
    Ok(state::get_message(id))
}

#[ic_cdk::query]
fn list_messages(offset: u64, limit: u64) -> Result<Vec<StoredMessage>, String> {
    require_controller()?;
    Ok(state::list_messages(offset, limit.min(100)))
}

#[ic_cdk::update]
async fn add_canister(canister_id: Principal) -> Result<AiCanister, String> {
    require_controller()?;
    let discovered = remote_tools::discover(canister_id).await?;
    state::set_ai_canister(discovered.clone());
    log_info(format!(
        "AI tool canister registered canister_id={canister_id}"
    ));
    Ok(discovered)
}

#[ic_cdk::update]
fn remove_canister(canister_id: Principal) -> Result<(), String> {
    require_controller()?;
    state::remove_ai_canister(canister_id)
        .ok_or_else(|| "canister is not registered".to_string())?;
    log_info(format!(
        "AI tool canister removed canister_id={canister_id}"
    ));
    Ok(())
}

#[ic_cdk::query]
fn list_canisters() -> Result<Vec<AiCanister>, String> {
    require_controller()?;
    Ok(state::list_ai_canisters())
}

// ---------------------------------------------------------------------------
// Business stats (open to any caller - see `AgentStats`'s doc comment)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_stats() -> AgentStats {
    state::get_stats()
}

#[ic_cdk::query]
fn get_connector_stats() -> u64 {
    state::message_count()
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent (or a human
/// implementer) to consume - what this template does, its security model,
/// and step by step how to adapt it for a specific business. Open to any
/// caller: it contains no secrets and is discoverable before authentication.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

ic_cdk::export_candid!();
