//! `connector`: a two-way message gateway between several outside services
//! and whatever's driving conversations on this canister's side (this
//! project's `orchestrator`, or anything else).
//!
//! **Inbound** - each service lands in its own way, all ending up as a
//! `StoredMessage` (`messages.rs`) queryable via `list_messages`/`get_message`:
//! - **WhatsApp** and **Telegram**, each via their own webhook HTTP endpoint
//!   (`http_request`/`http_request_update` - see `http.rs`'s doc comment for
//!   why both exist).
//! - **Mail**, via `receive_mail` - the same candid method `mail_bridge`
//!   forwards inbound mail to (see `services/mail_bridge/README.md`'s "The
//!   `receive_mail` interface").
//!
//! **Outbound** - `send_message` takes a channel-tagged `OutboundMessage`
//! and relays it out via that channel's own API (`outbound.rs`): the
//! WhatsApp Cloud API, Telegram's Bot API, or `mail_bridge`'s `/send_mail`.
//!
//! ## Configuration
//!
//! Every runtime parameter (channel secrets/tokens, the two authorized
//! principals) lives in one `Config` record (`config.rs`) - passed whole to
//! `init` at deploy time. `update_config` takes a `ConfigUpdate` instead of
//! a whole `Config`: every field is independently optional (three states -
//! not mentioned / clear it / set it - see `ConfigUpdate`'s doc comment), so
//! a call only needs to name the field(s) it actually means to change.
//! `get_config` reads back the fully materialized `Config`.
//!
//! ## Security model
//!
//! Follows the `canister-security` skill's guidance for exactly this split:
//! - **HTTP endpoints have no caller identity to check** ("HTTP requests
//!   bypass the IC's authentication layer entirely") - trust is established
//!   cryptographically instead:
//!   - WhatsApp: `X-Hub-Signature-256` HMAC-SHA256, keyed by `whatsapp_app_secret`.
//!   - Telegram: `X-Telegram-Bot-Api-Secret-Token` header, compared to `telegram_secret_token`.
//! - **`receive_mail` and `send_message` are ordinary candid calls**, so
//!   they get full IC caller-identity guarantees: `receive_mail` is gated on
//!   `msg_caller()` matching `mail_bridge_principal`; `send_message` on it
//!   matching `authorized_sender` (a controller may always call either).
//! - **`update_config`/`get_config` and every message-reading query are
//!   controller-gated** - `Config` holds several secrets, and stored
//!   messages can carry personal data (phone numbers, email addresses,
//!   message text), so neither is readable by arbitrary callers by default.

mod config;
mod http;
mod messages;
mod outbound;
mod state;
mod telegram;
mod whatsapp;

// Re-exported so integration tests (`tests/connector_tests.rs`) can encode/
// decode candid calls against real Rust types instead of hand-building
// candid values.
pub use config::{Config, ConfigUpdate};
pub use http::{HttpRequest, HttpResponse};
pub use messages::{AuthResult, Channel, MailMessage, MessagePayload, OutboundMessage, StoredMessage, TelegramMessage, WhatsAppMessage};

use candid::{CandidType, Principal};
use serde::Deserialize;

fn require_controller() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if ic_cdk::api::is_controller(&caller) {
        Ok(())
    } else {
        Err("only a controller may call this method".to_string())
    }
}

/// A controller may always call `receive_mail`/`send_message`, in addition
/// to whichever principal `expected` names (`Config::mail_bridge_principal`/
/// `authorized_sender`) - useful for testing and manual intervention without
/// having to impersonate the configured service's identity.
fn require_authorized(caller: Principal, expected: Option<Principal>, role: &str) -> Result<(), String> {
    if caller == Principal::anonymous() {
        return Err("anonymous caller not allowed".to_string());
    }
    if ic_cdk::api::is_controller(&caller) {
        return Ok(());
    }
    match expected {
        None => Err(format!("{role} is not configured - a controller must call update_config first")),
        Some(expected) if expected == caller => Ok(()),
        Some(_) => Err(format!("caller is not the configured {role}")),
    }
}

fn store(payload: MessagePayload) -> u64 {
    let id = state::next_message_id();
    state::insert_message(StoredMessage { id, received_at: ic_cdk::api::time(), payload: payload.clone() });
    outbound::forward_to_agent(&state::get_config(), &payload);
    id
}

#[ic_cdk::init]
fn init(config: Config) {
    state::set_config(config);
}

// ---------------------------------------------------------------------------
// Mail (candid, called by mail_bridge)
// ---------------------------------------------------------------------------

/// Accepts one piece of inbound mail forwarded by `mail_bridge`. Only that
/// bridge's own identity (`Config::mail_bridge_principal`) may call this -
/// unlike the HTTP webhooks below, this arrives as a regular update call, so
/// `msg_caller()` is meaningful and enforced.
#[ic_cdk::update]
fn receive_mail(mail: MailMessage) -> Result<(), String> {
    require_authorized(ic_cdk::api::msg_caller(), state::get_config().mail_bridge_principal, "mail bridge")?;
    store(MessagePayload::Mail(mail));
    Ok(())
}

// ---------------------------------------------------------------------------
// send_message (candid): relay a reply out to WhatsApp, Telegram, or mail
// ---------------------------------------------------------------------------

/// Sends `msg` out through the channel it names - see `outbound.rs` for each
/// channel's own API call and why every one of them is a single-replica
/// outcall. Only `Config::authorized_sender` (or a controller) may call
/// this - unrestricted access would let anyone spend this canister's
/// configured WhatsApp/Telegram/mail_bridge credentials to send arbitrary
/// messages.
#[ic_cdk::update]
async fn send_message(msg: OutboundMessage) -> Result<(), String> {
    let config = state::get_config();
    require_authorized(ic_cdk::api::msg_caller(), config.authorized_sender, "sender")?;
    match msg.channel {
        Channel::WhatsApp => outbound::send_whatsapp(&config, &msg).await,
        Channel::Telegram => outbound::send_telegram(&config, &msg).await,
        Channel::Email => outbound::send_mail(&config, &msg).await,
    }
}

// ---------------------------------------------------------------------------
// HTTP webhooks (WhatsApp, Telegram)
// ---------------------------------------------------------------------------

const WHATSAPP_PATH: &str = "/webhook/whatsapp";
const TELEGRAM_PATH: &str = "/webhook/telegram";

/// First stop for every inbound HTTP request (a query call - see `http.rs`'s
/// doc comment). Handles WhatsApp's GET verification handshake directly
/// (read-only, safe from a query call); every POST that would mutate state
/// is bounced to `http_request_update` via `upgrade: Some(true)` instead of
/// being processed here.
#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    match (req.method.as_str(), path) {
        ("GET", WHATSAPP_PATH) => match state::get_config().whatsapp_verify_token {
            Some(token) => whatsapp::verify_handshake(&req, &token),
            None => HttpResponse::text(503, "whatsapp_verify_token is not configured"),
        },
        ("POST", WHATSAPP_PATH) | ("POST", TELEGRAM_PATH) => HttpResponse::upgrade_to_update(),
        _ => HttpResponse::not_found(),
    }
}

/// Handles what `http_request` upgraded to an update call - the only place
/// webhook POST bodies are actually verified, parsed, and stored, since only
/// an update call is replicated through consensus.
#[ic_cdk::update]
fn http_request_update(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    match (req.method.as_str(), path) {
        ("POST", WHATSAPP_PATH) => handle_whatsapp_post(&req),
        ("POST", TELEGRAM_PATH) => handle_telegram_post(&req),
        _ => HttpResponse::not_found(),
    }
}

fn handle_whatsapp_post(req: &HttpRequest) -> HttpResponse {
    let config = state::get_config();
    let Some(secret) = config.whatsapp_app_secret else {
        return HttpResponse::text(503, "whatsapp_app_secret is not configured");
    };
    if !whatsapp::verify_signature(&req.body, whatsapp::header_signature(req), &secret) {
        return HttpResponse::text(401, "invalid signature");
    }
    match whatsapp::parse_messages(&req.body) {
        Ok(messages) => {
            for msg in messages {
                store(MessagePayload::WhatsApp(msg));
            }
            HttpResponse::text(200, "ok")
        }
        Err(e) => HttpResponse::text(400, e),
    }
}

fn handle_telegram_post(req: &HttpRequest) -> HttpResponse {
    let config = state::get_config();
    let Some(secret) = config.telegram_secret_token else {
        return HttpResponse::text(503, "telegram_secret_token is not configured");
    };
    if !telegram::verify_secret(req, &secret) {
        return HttpResponse::text(401, "invalid secret token");
    }
    match telegram::parse_update(&req.body) {
        // A recognized-but-not-message-like update (e.g. a callback query) -
        // still ack it so Telegram doesn't keep retrying.
        Ok(None) => HttpResponse::text(200, "ok"),
        Ok(Some(msg)) => {
            store(MessagePayload::Telegram(msg));
            HttpResponse::text(200, "ok")
        }
        Err(e) => HttpResponse::text(400, e),
    }
}

// ---------------------------------------------------------------------------
// Configuration (controller-only - see this module's doc comment)
// ---------------------------------------------------------------------------

/// Applies `update` to the current configuration, field by field - see
/// `ConfigUpdate`'s doc comment for its three-state-per-field semantics.
#[ic_cdk::update]
fn update_config(update: ConfigUpdate) -> Result<(), String> {
    require_controller()?;
    state::set_config(state::get_config().apply(update));
    Ok(())
}

#[ic_cdk::query]
fn get_config() -> Result<Config, String> {
    require_controller()?;
    Ok(state::get_config())
}

// ---------------------------------------------------------------------------
// Reading messages back (controller-only - see this module's doc comment)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_message(id: u64) -> Result<Option<StoredMessage>, String> {
    require_controller()?;
    Ok(state::get_message(id))
}

/// Newest-first, paginated via `offset`/`limit`.
#[ic_cdk::query]
fn list_messages(offset: u64, limit: u64) -> Result<Vec<StoredMessage>, String> {
    require_controller()?;
    Ok(state::list_messages(offset, limit))
}

// ---------------------------------------------------------------------------
// Business stats (open to any caller - see `ConnectorStats`'s doc comment)
// ---------------------------------------------------------------------------

/// Business-level activity, as opposed to the infrastructure-level numbers
/// `icp canister status` already reports (cycles, memory, module hash) -
/// this is what an operator dashboard or an LLM agent actually cares about:
/// how much traffic this gateway has moved. Deliberately open to any caller
/// (no `require_controller` gate), same reasoning as `llm_context` below -
/// an aggregate count isn't sensitive the way stored message content is.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ConnectorStats {
    pub messages_processed: u64,
}

#[ic_cdk::query]
fn get_stats() -> ConnectorStats {
    ConnectorStats { messages_processed: state::message_count() }
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent to consume - what it
/// does, every method's purpose and access control, and the non-obvious
/// semantics candid types alone don't convey (which principal each gated
/// method expects, the single-replica outcall tradeoff behind
/// `send_message`, channel-specific quirks). Open to any caller: unlike
/// `get_config`/`list_messages`, there's nothing sensitive in a description
/// of the canister's own shape, and an agent needs to be able to read this
/// *before* it has any credentials to call anything else.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

ic_cdk::export_candid!();
