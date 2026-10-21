//! `agent`: a **template** for an AI customer-support canister -
//! not meant to be deployed as-is, but cloned and adapted per business (see
//! `llm_context.md` for exactly how, and read `tools.rs`'s and `admin.rs`'s
//! doc comments before changing anything - they document the security
//! boundary this whole template exists to enforce).
//!
//! ## The shape of one conversation turn
//!
//! 1. `connector` forwards an inbound customer message via `receive_message`
//!    (only `Config::connector_principal` may call this).
//! 2. `llm::run_agent_loop` sends the conversation (system prompt, history,
//!    and the new message) to whichever LLM provider is configured (an
//!    HTTPS outcall via `ic_rig` - see `llm.rs`'s doc comment), executing
//!    whatever tools it asks for and looping until it has a final answer.
//! 3. Every tool it can call is either an ordinary customer-scoped,
//!    non-administrative action (`tools.rs`), or the one reserved
//!    `request_admin_action` escalation hatch, which never performs
//!    anything itself - it only files a request and notifies an external
//!    system over a signed webhook (`admin.rs`). **The model itself never
//!    has a path to anything administrative.**
//! 4. The final answer is persisted to that conversation's history and sent
//!    back to the customer via `connector::send_message`.
//! 5. If an administrative request was filed, the external system
//!    eventually calls back `POST /webhook/admin` with a resolution; this
//!    canister relays that resolution to the customer the same way,
//!    independently of any further LLM involvement.
//!
//! ## Configuration
//!
//! One `Config` record (`config.rs`), installed whole by `init` and updated
//! field-by-field by `update_config` - see that module's doc comment for
//! the exact (three-state-per-field) semantics, identical to `connector`'s.
//!
//! ## Security model
//!
//! - `receive_message` is gated on `Config::connector_principal` (a
//!   controller may always call it too).
//! - `POST /webhook/admin` has no caller identity (HTTP requests bypass the
//!   IC's authentication layer) - gated on an HMAC-SHA256 signature keyed by
//!   `Config::admin_webhook_secret` instead (see `admin.rs`).
//! - Every tool the model can call directly is scoped to the current
//!   conversation's own customer and cannot be administrative - see
//!   `tools.rs`'s doc comment for exactly how that's enforced structurally,
//!   not just by convention.
//! - `update_config`/`get_config` and every observability query
//!   (`list_admin_requests`, `get_admin_request`, `get_conversation`) are
//!   controller-only.
//! - One conversation is processed at a time (`SessionGuard`, below) -
//!   prevents two concurrent messages for the same customer from
//!   interleaving history reads/writes across the `await` points in
//!   `llm::run_agent_loop`. Keyed by conversation, not by caller: every
//!   inbound message's caller is the same `connector` principal, so guarding
//!   by caller (the usual `CallerGuard` pattern - see the
//!   `canister-security` skill) would serialize *every* customer's
//!   conversations against each other, not just concurrent messages within
//!   one.

// Keep the dependency version selected by the packages workspace while
// exposing the canonical crate name expected by ic-cdk's procedural macros.
extern crate ic_cdk_020 as ic_cdk;

mod admin;
mod config;
mod db;
mod http;
mod llm;
mod messages;
mod outbound;
mod state;
mod tools;

// Re-exported so integration tests (`tests/agent_tests.rs`) can
// encode/decode candid calls against real Rust types instead of hand-
// building candid values.
pub use config::{Config, ConfigUpdate};
pub use http::{HttpRequest, HttpResponse};
pub use messages::{AdminRequest, AdminRequestStatus, Channel, ConversationState, AgentStats, IncomingMessage, Role, StoredChatMessage};

use candid::Principal;
use messages::SessionKey;
use std::cell::RefCell;
use std::collections::BTreeSet;

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
                return Err("already processing a message for this conversation - try again shortly".to_string());
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
        Err("only a controller may call this method".to_string())
    }
}

/// A controller may always call `receive_message`, in addition to whichever
/// principal `expected` names - useful for testing and manual intervention
/// without impersonating `connector`'s identity.
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

#[ic_cdk::init]
fn init(config: Config) {
    state::set_config(config);
}

// ---------------------------------------------------------------------------
// receive_message (candid, called by connector)
// ---------------------------------------------------------------------------

/// Accepts one inbound customer message forwarded by `connector`, runs it
/// through the LLM/tool-calling loop, persists the resulting turn, and
/// relays the reply back out via `connector::send_message`. See this
/// module's doc comment for the full flow and `llm::run_agent_loop` for the
/// loop itself.
#[ic_cdk::update]
async fn receive_message(msg: IncomingMessage) -> Result<(), String> {
    let config = state::get_config();
    require_authorized(ic_cdk::api::msg_caller(), config.connector_principal, "connector")?;
    let Some(connector_id) = config.connector_principal else {
        return Err("connector_principal is not configured - a controller must call update_config first".to_string());
    };

    let customer = SessionKey::from(&msg);
    // Held for the rest of this function - see `SessionGuard`'s doc comment.
    let _guard = SessionGuard::new(customer.clone())?;

    let mut conversation = state::get_conversation(&customer);
    let history = conversation.to_rig_history();
    let reply_text = llm::run_agent_loop(&customer, &config, history, &msg.text).await;
    state::record_turn();

    let now = ic_cdk::api::time();
    conversation.history.push(StoredChatMessage { role: Role::User, content: msg.text, at: now });
    conversation.history.push(StoredChatMessage { role: Role::Assistant, content: reply_text.clone(), at: now });
    state::append_turn(&customer, conversation);

    outbound::reply_to_customer(connector_id, &customer, &reply_text).await
}

// ---------------------------------------------------------------------------
// HTTP webhook (administrative callback only - see admin.rs)
// ---------------------------------------------------------------------------

const ADMIN_WEBHOOK_PATH: &str = "/webhook/admin";

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
        ("POST", ADMIN_WEBHOOK_PATH) => HttpResponse::upgrade_to_update(),
        _ => HttpResponse::not_found(),
    }
}

/// Verifies and applies an administrative resolution (see
/// `admin::handle_callback`), then relays its `result_message` to the
/// customer via `connector::send_message` - independent of, and without
/// re-invoking, the LLM (see `admin.rs`'s doc comment on `handle_callback`
/// for why).
#[ic_cdk::update]
async fn http_request_update(req: HttpRequest) -> HttpResponse {
    let (path, _) = http::path_and_query(&req.url);
    match (req.method.as_str(), path) {
        ("POST", ADMIN_WEBHOOK_PATH) => handle_admin_callback(&req).await,
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
        if let Some(connector_id) = state::get_config().connector_principal {
            let customer = SessionKey { channel: updated.channel, session_id: updated.session_id.clone() };
            if let Err(e) = outbound::reply_to_customer(connector_id, &customer, message).await {
                ic_cdk::api::debug_print(format!("agent: failed to relay admin callback #{} to customer: {e}", updated.id));
            }
        }
    }
    HttpResponse::text(200, "ok")
}

// ---------------------------------------------------------------------------
// Configuration (controller-only)
// ---------------------------------------------------------------------------

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
// Observability (controller-only)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_conversation(channel: Channel, session_id: String) -> Result<ConversationState, String> {
    require_controller()?;
    Ok(state::get_conversation(&SessionKey { channel, session_id }))
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

// ---------------------------------------------------------------------------
// Business stats (open to any caller - see `AgentStats`'s doc comment)
// ---------------------------------------------------------------------------

#[ic_cdk::query]
fn get_stats() -> AgentStats {
    state::get_stats()
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// A prose description of this canister for an AI agent (or a human
/// implementer) to consume - what this template does, its security model,
/// and step by step how to adapt it for a specific business. Open to any
/// caller, same reasoning as `connector::llm_context`: nothing sensitive in
/// a description of the canister's own shape, and it needs to be readable
/// before anyone has credentials to call anything else here.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

ic_cdk::export_candid!();
