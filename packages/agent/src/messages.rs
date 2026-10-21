//! Candid types for the two things this canister persists per customer: a
//! conversation's turn-by-turn history, and any administrative-action
//! requests it has escalated - see `llm_context.md` for how the two relate.

use candid::CandidType;
use serde::{Deserialize, Serialize};

/// Matches `connector`'s `Channel` type field-for-field (candid matches by
/// shape, not by the two crates sharing a Rust type - see
/// `IncomingMessage`'s doc comment).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Channel {
    WhatsApp,
    Telegram,
    Email,
}

/// `receive_message`'s argument - what `connector` forwards for every
/// inbound customer message, normalized to just enough for this canister to
/// route and respond: which channel, which conversation (`session_id` -
/// literally the same address `connector` already uses: a WhatsApp number, a
/// Telegram chat id, or an email address), and the message text itself.
/// Deliberately minimal and channel-agnostic - a template shouldn't need to
/// know WhatsApp's or Telegram's raw payload shapes to hold a conversation.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct IncomingMessage {
    pub channel: Channel,
    pub session_id: String,
    pub text: String,
}

/// One identity a customer's conversation is filed under. This is also
/// **the security-critical value that scopes every customer-facing tool
/// call** - see `tools.rs`'s doc comment: every tool handler receives one of
/// these from the dispatcher (derived from where the message actually came
/// from), never from anything the model or the customer supplied, so a tool
/// can only ever act on the customer who is, right now, actually having
/// this conversation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionKey {
    pub channel: Channel,
    pub session_id: String,
}

impl From<&IncomingMessage> for SessionKey {
    fn from(msg: &IncomingMessage) -> Self {
        SessionKey { channel: msg.channel, session_id: msg.session_id.clone() }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StoredChatMessage {
    pub role: Role,
    pub content: String,
    /// Nanoseconds since the Unix epoch (`ic_cdk::api::time()`'s convention).
    pub at: u64,
}

/// One customer's conversation. Deliberately holds only *finished* turns
/// (one `User` message, one final `Assistant` reply) - the back-and-forth of
/// an in-progress tool-calling round (`ic_rig::Agent::chat` handles this
/// internally - see `llm.rs`'s doc comment) lives only for the duration of
/// that one `receive_message` call and is never persisted, which keeps this
/// bounded and keeps `ic_rig`'s own message types (which aren't candid
/// types - see this crate's own `StoredChatMessage` below instead) out of
/// the candid surface entirely. `history` is capped at
/// `state::MAX_HISTORY_MESSAGES` (oldest turns dropped first) to bound
/// stable memory growth and keep the prompt sent to the model on each turn
/// from growing unbounded.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct ConversationState {
    pub history: Vec<StoredChatMessage>,
}

impl ConversationState {
    /// Converts stored history into what `ic_rig::Agent::chat` expects -
    /// `Message::user`/`Message::assistant` text turns, in order. The
    /// system prompt is not included here; `llm::run_with_model` adds it
    /// separately via `Agent::builder(..).preamble(..)`.
    pub fn to_rig_history(&self) -> Vec<ic_rig::Message> {
        self.history
            .iter()
            .map(|m| match m.role {
                Role::User => ic_rig::Message::user(m.content.clone()),
                Role::Assistant => ic_rig::Message::assistant(m.content.clone()),
            })
            .collect()
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdminRequestStatus {
    Pending,
    Approved,
    Rejected,
    Completed,
}

/// A request to do something this canister's tools deliberately cannot do
/// themselves - created by the `request_admin_action` tool (see `tools.rs`),
/// POSTed to `Config.admin_webhook_url` (see `admin.rs`), and updated in
/// place when `POST /webhook/admin` calls back with a resolution.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct AdminRequest {
    pub id: u64,
    pub channel: Channel,
    pub session_id: String,
    /// Free-text, model-chosen category (e.g. `"refund"`,
    /// `"account_deletion"`, `"escalate"`) - see `tools.rs`'s doc comment on
    /// why this template leaves it as text rather than a fixed enum.
    pub action_type: String,
    /// Free-text detail the model provided - human-readable context for
    /// whoever/whatever handles this on the other side of the webhook, not
    /// something this canister parses or acts on itself.
    pub details: String,
    pub status: AdminRequestStatus,
    /// Set once `POST /webhook/admin` resolves this request - the text
    /// relayed back to the customer via `connector.send_message` verbatim
    /// (see `admin.rs::handle_callback`'s doc comment on why it's sent
    /// as-is rather than run back through the LLM).
    pub result_message: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Business-level activity, as opposed to the infrastructure-level numbers
/// `icp canister status` already reports (cycles, memory, module hash).
/// `messages_in`/`messages_out` count `receive_message` turns (one customer
/// message in, one reply out - always paired, since `run_agent_loop` always
/// produces some reply, even its own escalation fallback); `prompt_tokens`/
/// `completion_tokens` accumulate whatever the configured LLM provider
/// reports via `Usage` (see `llm.rs`'s `TrackingModel`) - `0` for either
/// simply means no completion has reported usage yet (some provider
/// responses omit it), not necessarily that none were made. Deliberately
/// open to any caller (no `require_controller` gate) - an aggregate count
/// isn't sensitive the way conversation content or `Config`'s secrets are.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct AgentStats {
    pub messages_in: u64,
    pub messages_out: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}
