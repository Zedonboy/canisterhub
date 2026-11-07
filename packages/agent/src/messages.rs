//! Candid types for the two things this canister persists per customer: a
//! conversation's turn-by-turn history, and any administrative-action
//! requests it has escalated - see `llm_context.md` for how the two relate.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// Matches `connector`'s `Channel` type field-for-field (candid matches by
/// shape, not by the two crates sharing a Rust type - see
/// `IncomingMessage`'s doc comment).
#[derive(
    CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
pub enum Channel {
    WhatsApp,
    Telegram,
    Email,
    /// Customers chatting on the canister's own web page (`chat-ui`), signed
    /// in with Internet Identity: `session_id` is the caller's principal text.
    /// Also hosts the SME's private agent console (`CONSOLE_SESSION`). Replies
    /// are stored in history only - there is nothing to deliver outbound.
    Web,
}

/// Information the agent can ask the client application to collect from the
/// current customer. The channel adapter decides whether this is rendered as
/// a native control (for example, a location button) or a typed reply.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientDataKind {
    Location,
    Text,
    Email,
    Phone,
    Number,
    Date,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClientDataRequest {
    pub id: u64,
    pub kind: ClientDataKind,
    pub prompt: String,
    pub created_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ClientDataValue {
    Location { latitude: f64, longitude: f64 },
    Text(String),
}

impl ClientDataValue {
    pub fn parse_location_text(text: &str) -> Option<Self> {
        let values = text
            .split(|character: char| {
                !(character.is_ascii_digit()
                    || character == '.'
                    || character == '-'
                    || character == '+')
            })
            .filter(|part| !part.is_empty())
            .map(str::parse::<f64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if values.len() != 2 {
            return None;
        }
        let value = Self::Location {
            latitude: values[0],
            longitude: values[1],
        };
        value
            .validate_for(ClientDataKind::Location)
            .ok()
            .map(|_| value)
    }

    pub fn validate_for(&self, kind: ClientDataKind) -> Result<(), String> {
        match (kind, self) {
            (
                ClientDataKind::Location,
                Self::Location {
                    latitude,
                    longitude,
                },
            ) if latitude.is_finite()
                && longitude.is_finite()
                && (-90.0..=90.0).contains(latitude)
                && (-180.0..=180.0).contains(longitude) =>
            {
                Ok(())
            }
            (ClientDataKind::Location, Self::Location { .. }) => Err(
                "latitude must be between -90 and 90 and longitude between -180 and 180"
                    .to_string(),
            ),
            (ClientDataKind::Location, _) => Err("this request requires a location".to_string()),
            (_, Self::Text(value)) if value.trim().is_empty() => {
                Err("the requested value must not be empty".to_string())
            }
            (_, Self::Text(value)) if value.chars().count() > 2_000 => {
                Err("the requested value is longer than 2000 characters".to_string())
            }
            (_, Self::Text(_)) => Ok(()),
            (_, Self::Location { .. }) => Err("this request requires a text value".to_string()),
        }
    }

    pub fn as_prompt_text(&self, kind: ClientDataKind) -> String {
        match self {
            Self::Location {
                latitude,
                longitude,
            } => format!(
                "Client provided the requested location: latitude={latitude}, longitude={longitude}."
            ),
            Self::Text(value) => format!(
                "Client provided the requested {}: {}",
                kind.label(),
                value.trim()
            ),
        }
    }
}

impl ClientDataKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Location => "location",
            Self::Text => "information",
            Self::Email => "email address",
            Self::Phone => "phone number",
            Self::Number => "number",
            Self::Date => "date",
        }
    }
}

#[cfg(test)]
mod client_data_tests {
    use super::*;

    #[test]
    fn typed_coordinates_are_accepted_without_guessing_from_extra_numbers() {
        assert_eq!(
            ClientDataValue::parse_location_text("latitude=6.5244, longitude=3.3792"),
            Some(ClientDataValue::Location {
                latitude: 6.5244,
                longitude: 3.3792,
            })
        );
        assert!(ClientDataValue::parse_location_text("Call 0800 near 6.5, 3.3").is_none());
        assert!(ClientDataValue::parse_location_text("91, 3").is_none());
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StoredMessage {
    pub id: u64,
    pub received_at: u64,
    pub payload: MessagePayload,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum MessagePayload {
    WhatsApp(WhatsAppMessage),
    Telegram(TelegramMessage),
    Mail(MailMessage),
}

impl MessagePayload {
    pub fn incoming(&self) -> Option<IncomingMessage> {
        match self {
            Self::WhatsApp(m) => location_text(m.latitude, m.longitude)
                .or_else(|| m.text.clone())
                .map(|text| IncomingMessage {
                    channel: Channel::WhatsApp,
                    session_id: m.from.clone(),
                    text,
                }),
            Self::Telegram(m) => location_text(m.latitude, m.longitude)
                .or_else(|| m.text.clone())
                .map(|text| IncomingMessage {
                    channel: Channel::Telegram,
                    session_id: m.chat_id.to_string(),
                    text,
                }),
            Self::Mail(m) => Some(IncomingMessage {
                channel: Channel::Email,
                session_id: m.envelope_from.clone(),
                text: m.text_body.clone().unwrap_or_else(|| m.subject.clone()),
            }),
        }
    }

    pub fn client_data(&self) -> Option<ClientDataValue> {
        match self {
            Self::WhatsApp(m) => coordinates(m.latitude, m.longitude),
            Self::Telegram(m) => coordinates(m.latitude, m.longitude),
            Self::Mail(_) => None,
        }
    }
}

fn coordinates(latitude: Option<f64>, longitude: Option<f64>) -> Option<ClientDataValue> {
    Some(ClientDataValue::Location {
        latitude: latitude?,
        longitude: longitude?,
    })
}

fn location_text(latitude: Option<f64>, longitude: Option<f64>) -> Option<String> {
    coordinates(latitude, longitude).map(|value| value.as_prompt_text(ClientDataKind::Location))
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct OutboundMessage {
    pub channel: Channel,
    pub session_id: String,
    pub text: String,
    pub subject: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppMessage {
    pub message_id: String,
    pub from: String,
    pub to: Option<String>,
    pub message_type: String,
    pub text: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub timestamp: Option<String>,
    pub raw: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TelegramMessage {
    pub update_id: i64,
    pub message_id: Option<i64>,
    pub chat_id: i64,
    pub from_user_id: Option<i64>,
    pub from_username: Option<String>,
    pub text: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub date: Option<i64>,
    pub raw: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MailMessage {
    pub envelope_from: String,
    pub envelope_to: Vec<String>,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub headers: Vec<(String, String)>,
    pub received_at: u64,
    pub spf: AuthResult,
    pub dkim: AuthResult,
    pub dmarc: AuthResult,
    pub tls: bool,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthResult {
    Pass,
    Fail,
    SoftFail,
    Neutral,
    None,
    TempError,
    PermError,
}

/// Trusted conversation identity passed by this agent to every `ai_*`
/// method. Target canisters must scope their action to this value and must
/// not accept identity fields from the JSON parameters.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiContext {
    pub project_id: String,
    pub agent_canister_id: Principal,
    pub channel: Channel,
    pub session_id: String,
}

/// A business package can ask the agent to message a session without
/// selecting a channel. The agent resolves the channel from its conversation
/// store so the caller cannot misroute a customer's message.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct BusinessMessage {
    pub session_id: String,
    pub text: String,
    pub subject: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AiMethod {
    pub name: String,
    pub description: String,
    pub parameters: String,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AiCanister {
    pub canister_id: Principal,
    pub description: String,
    pub methods: Vec<AiMethod>,
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
        SessionKey {
            channel: msg.channel,
            session_id: msg.session_id.clone(),
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    /// A reply typed by the business owner/staff (`operator_reply`) rather
    /// than the model.
    Operator,
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
/// One row of the SME inbox (`list_conversations`): where the conversation is
/// from, and its latest turn.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ConversationSummary {
    pub channel: Channel,
    pub session_id: String,
    /// A friendlier label than `session_id` when one is known (none stored yet).
    pub display_name: Option<String>,
    pub last_text: String,
    pub last_role: Role,
    pub last_at: u64,
    pub message_count: u64,
}

/// Reserved web-channel session holding the SME's private conversation with
/// the agent (`console_message`). A real customer's session id is an
/// Internet Identity principal's text, which can never equal this.
pub const CONSOLE_SESSION: &str = "__sme_console__";

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
                // Shown to the model as its own earlier turn, but labelled so it
                // knows a human took over rather than imitating that voice.
                Role::Operator => {
                    ic_rig::Message::assistant(format!("[Reply from a team member] {}", m.content))
                }
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
