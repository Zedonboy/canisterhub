//! The candid shapes this canister stores: one per inbound channel
//! (WhatsApp, Telegram, mail), unified under `StoredMessage` for a single
//! query surface (`list_messages`/`get_message`).

use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StoredMessage {
    pub id: u64,
    /// Nanoseconds since the Unix epoch (`ic_cdk::api::time()`'s convention)
    /// - when this canister received the message, not necessarily when the
    ///   upstream service says it was sent (see each payload's own timestamp
    ///   field for that).
    pub received_at: u64,
    pub payload: MessagePayload,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum MessagePayload {
    WhatsApp(WhatsAppMessage),
    Telegram(TelegramMessage),
    Mail(MailMessage),
}

/// Which outside service a message came from or is going to - shared between
/// inbound (`MessagePayload`'s variants, above) and outbound
/// (`OutboundMessage`, below) even though the two aren't the same type: an
/// inbound message carries a whole channel-specific record, while an
/// outbound one is deliberately minimal (see `OutboundMessage`'s doc
/// comment).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    WhatsApp,
    Telegram,
    Email,
}

/// The argument to `send_message` (see `lib.rs`): a reply to relay out to
/// one of the three channels, addressed by `session_id` rather than a
/// channel-specific type - literally the same identifier this canister
/// already handed back on the matching inbound `StoredMessage`:
/// `WhatsAppMessage.from`, `TelegramMessage.chat_id` (stringified - Telegram
/// chat ids are signed integers, but a `text` field here keeps all three
/// channels uniform), or `MailMessage.envelope_from`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct OutboundMessage {
    pub channel: Channel,
    pub session_id: String,
    pub text: String,
    /// Email only (ignored for WhatsApp/Telegram, neither of which have a
    /// concept of a subject line) - defaults to `"Message"` if omitted,
    /// since `mail_bridge`'s `/send_mail` requires one.
    pub subject: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppMessage {
    /// WhatsApp's own message id (`messages[].id`) - stable, useful for
    /// dedup if the Cloud API redelivers a webhook.
    pub message_id: String,
    /// Sender's WhatsApp ID (a phone number, no `+` or formatting).
    pub from: String,
    /// The business phone number this arrived on
    /// (`value.metadata.display_phone_number`) - a connector may be
    /// configured with more than one WhatsApp number behind one webhook URL.
    pub to: Option<String>,
    /// `messages[].type` - `"text"`, `"image"`, `"button"`, etc. Only
    /// `"text"` is unpacked into `text` below; every other type still gets
    /// stored, with its full JSON in `raw` for a caller that needs it.
    pub message_type: String,
    pub text: Option<String>,
    /// Unix seconds, as WhatsApp sends it (a JSON string, not a number).
    pub timestamp: Option<String>,
    /// The raw JSON of this one message object, for fields not surfaced above
    /// (media ids, interactive replies, location, etc.).
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
    /// Unix seconds, as Telegram sends it.
    pub date: Option<i64>,
    /// The raw JSON of the whole `Update` object.
    pub raw: String,
}

/// Field-for-field identical to `mail_bridge`'s `IncomingMail` candid type
/// (see `services/mail_bridge/src/mail/message.rs`) - candid matches record fields by
/// name, not by the two crates sharing a Rust type, so this has to be kept in
/// sync by hand if that struct's shape ever changes.
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

/// Identical to `mail_bridge`'s `mail::auth::AuthResult` - see that type's
/// doc comment for what each variant means.
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
