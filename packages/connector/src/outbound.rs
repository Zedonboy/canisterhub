//! Relaying a `send_message` call (see `lib.rs`) out to the channel it names,
//! each via its own HTTPS outcall.
//!
//! ## Why `is_replicated: Some(false)` on every call here
//!
//! By default an outcall is made independently by every replica on the
//! subnet, which then have to agree byte-for-byte on a transformed response
//! to reach consensus (see the `https-outcalls` skill). That's the right
//! model for a *read* whose result feeds into consensus-critical state (this
//! project's `backend::verify_repo_ownership` is exactly that: several
//! replicas really do hit the GitHub API independently, and that's fine -
//! GitHub's answer doesn't change based on who's asking).
//!
//! Sending a message is the opposite: the whole point is a real-world
//! side effect (an actual WhatsApp/Telegram message, an actual email) that
//! should happen once, not once per replica. Meta's, Telegram's, and
//! `mail_bridge`'s own send endpoints have no request-deduplication
//! mechanism a canister could rely on here, so the default replicated
//! behavior would mean every `send_message` call visibly delivers the same
//! text N times (N = subnet size). `is_replicated: Some(false)` has the
//! management canister route the call through a single replica instead -
//! trading the subnet's usual byte-identical-consensus guarantee (not
//! meaningful for a fire-and-forget POST anyway) for the exactly-once
//! semantics this actually needs. The cost is that a single misbehaving or
//! offline replica can make one `send_message` call fail even though the
//! rest of the subnet is healthy - `send_message` surfaces that as an `Err`
//! rather than silently swallowing it, so a caller can decide whether to
//! retry (which risks a second real delivery if the first one *did* land,
//! same as retrying any non-idempotent API call would).

use crate::config::Config;
use crate::messages::OutboundMessage;
use ic_cdk::management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

/// WhatsApp Cloud API version this canister sends against. Meta versions its
/// Graph API and eventually retires old versions - check
/// https://developers.facebook.com/docs/graph-api/changelog/ if send calls
/// start failing with a deprecation error, and bump this.
const WHATSAPP_GRAPH_API_VERSION: &str = "v21.0";

pub async fn send_whatsapp(config: &Config, msg: &OutboundMessage) -> Result<(), String> {
    let access_token = config.whatsapp_access_token.as_deref().ok_or("whatsapp_access_token is not configured")?;
    let phone_number_id = config.whatsapp_phone_number_id.as_deref().ok_or("whatsapp_phone_number_id is not configured")?;

    let url = format!("https://graph.facebook.com/{WHATSAPP_GRAPH_API_VERSION}/{phone_number_id}/messages");
    let body = serde_json::json!({
        "messaging_product": "whatsapp",
        "to": msg.session_id,
        "type": "text",
        "text": { "body": msg.text },
    });
    post_json(&url, &[("Authorization".to_string(), format!("Bearer {access_token}"))], &body).await
}

pub async fn send_telegram(config: &Config, msg: &OutboundMessage) -> Result<(), String> {
    let token = config.telegram_bot_token.as_deref().ok_or("telegram_bot_token is not configured")?;
    let chat_id: i64 = msg.session_id.parse().map_err(|_| format!("'{}' is not a valid Telegram chat id (expected an integer)", msg.session_id))?;

    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = serde_json::json!({ "chat_id": chat_id, "text": msg.text });
    post_json(&url, &[], &body).await
}

pub async fn send_mail(config: &Config, msg: &OutboundMessage) -> Result<(), String> {
    let base_url = config.mail_bridge_url.as_deref().ok_or("mail_bridge_url is not configured")?;
    let api_key = config.mail_bridge_api_key.as_deref().ok_or("mail_bridge_api_key is not configured")?;
    let from = config.mail_from_address.as_deref().ok_or("mail_from_address is not configured")?;

    let url = format!("{}/send_mail", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "from": from,
        "to": [msg.session_id],
        "subject": msg.subject.clone().unwrap_or_else(|| "Message".to_string()),
        "text_body": msg.text,
    });
    post_json(&url, &[("Authorization".to_string(), format!("Bearer {api_key}"))], &body).await
}

/// Shared by all three senders above: a single-replica (see this module's
/// doc comment), `application/json` POST, treating any non-`200` response as
/// a failure - true of the WhatsApp Cloud API, Telegram's Bot API, and
/// `mail_bridge`'s `/send_mail` alike.
async fn post_json(url: &str, extra_headers: &[(String, String)], body: &serde_json::Value) -> Result<(), String> {
    let mut headers = vec![HttpHeader { name: "Content-Type".to_string(), value: "application/json".to_string() }];
    headers.extend(extra_headers.iter().cloned().map(|(name, value)| HttpHeader { name, value }));

    let request = HttpRequestArgs {
        url: url.to_string(),
        // These are small JSON acks/errors, not the payload itself - plenty
        // of headroom without paying to reserve the 2MB default.
        max_response_bytes: Some(4_096),
        method: HttpMethod::POST,
        headers,
        body: Some(body.to_string().into_bytes()),
        // No transform: a single replica executes this (see the module doc
        // comment), so there's no cross-replica response to reconcile.
        transform: None,
        is_replicated: Some(false),
    };

    let response = http_request(&request).await.map_err(|e| format!("outcall to {url} failed: {e:?}"))?;
    if response.status != 200u32 {
        let body_text = String::from_utf8_lossy(&response.body);
        return Err(format!("{url} returned status {}: {body_text}", response.status));
    }
    Ok(())
}

/// The argument shape `Config::agent_canister`'s `receive_message` method is
/// expected to accept - field-for-field identical to e.g. `agent`'s
/// `IncomingMessage` (candid matches by shape, not by the two crates sharing
/// a Rust type).
#[derive(candid::CandidType, serde::Serialize)]
struct AgentIncomingMessage {
    channel: crate::messages::Channel,
    session_id: String,
    text: String,
}

/// Forwards one just-stored inbound message to `Config::agent_canister` (if
/// configured) as a normalized `{channel, session_id, text}` - the same
/// three fields regardless of source, so an agent canister doesn't need to
/// know WhatsApp's or Telegram's raw payload shapes. A message with no text
/// content (e.g. a WhatsApp image with no caption) is not forwarded at all -
/// there's nothing for an agent to reasonably reply to.
///
/// Fire-and-forget (`Call::oneway`, not awaited): forwarding is a secondary
/// concern relative to the webhook's/`receive_mail`'s own job of durably
/// storing the message, which has already happened by the time this is
/// called - a slow, failing, or unconfigured agent must never affect that
/// response, and must especially never turn into a `receive_mail` error
/// (which `mail_bridge` would read as "delivery failed" and bounce over,
/// for a completely unrelated downstream hiccup).
pub fn forward_to_agent(config: &crate::config::Config, payload: &crate::messages::MessagePayload) {
    let Some(agent_canister) = config.agent_canister else {
        return;
    };
    let Some((channel, session_id, text)) = route_of(payload) else {
        return;
    };

    let msg = AgentIncomingMessage { channel, session_id, text };
    if let Err(e) = ic_cdk::call::Call::bounded_wait(agent_canister, "receive_message").with_arg(msg).oneway() {
        ic_cdk::api::debug_print(format!("connector: failed to enqueue forward to agent_canister: {e:?}"));
    }
}

fn route_of(payload: &crate::messages::MessagePayload) -> Option<(crate::messages::Channel, String, String)> {
    use crate::messages::{Channel, MessagePayload};
    match payload {
        MessagePayload::WhatsApp(m) => m.text.clone().map(|text| (Channel::WhatsApp, m.from.clone(), text)),
        MessagePayload::Telegram(m) => m.text.clone().map(|text| (Channel::Telegram, m.chat_id.to_string(), text)),
        MessagePayload::Mail(m) => {
            let text = m.text_body.clone().unwrap_or_else(|| m.subject.clone());
            Some((Channel::Email, m.envelope_from.clone(), text))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{AuthResult, Channel, MailMessage, MessagePayload, TelegramMessage, WhatsAppMessage};

    #[test]
    fn route_of_whatsapp_uses_from_as_session_id() {
        let payload = MessagePayload::WhatsApp(WhatsAppMessage {
            message_id: "wamid.1".to_string(),
            from: "15551234567".to_string(),
            to: None,
            message_type: "text".to_string(),
            text: Some("hi".to_string()),
            timestamp: None,
            raw: "{}".to_string(),
        });
        assert_eq!(route_of(&payload), Some((Channel::WhatsApp, "15551234567".to_string(), "hi".to_string())));
    }

    #[test]
    fn route_of_whatsapp_skips_messages_with_no_text() {
        let payload = MessagePayload::WhatsApp(WhatsAppMessage {
            message_id: "wamid.1".to_string(),
            from: "15551234567".to_string(),
            to: None,
            message_type: "image".to_string(),
            text: None,
            timestamp: None,
            raw: "{}".to_string(),
        });
        assert_eq!(route_of(&payload), None, "a non-text message has nothing for an agent to reply to");
    }

    #[test]
    fn route_of_telegram_stringifies_chat_id() {
        let payload = MessagePayload::Telegram(TelegramMessage {
            update_id: 1,
            message_id: Some(2),
            chat_id: 42,
            from_user_id: None,
            from_username: None,
            text: Some("hi".to_string()),
            date: None,
            raw: "{}".to_string(),
        });
        assert_eq!(route_of(&payload), Some((Channel::Telegram, "42".to_string(), "hi".to_string())));
    }

    #[test]
    fn route_of_mail_prefers_text_body_and_falls_back_to_subject() {
        let mut mail = MailMessage {
            envelope_from: "a@example.com".to_string(),
            envelope_to: vec![],
            from: "a@example.com".to_string(),
            to: vec![],
            subject: "Hello".to_string(),
            text_body: Some("body text".to_string()),
            html_body: None,
            headers: vec![],
            received_at: 0,
            spf: AuthResult::Pass,
            dkim: AuthResult::Pass,
            dmarc: AuthResult::Pass,
            tls: true,
        };
        assert_eq!(route_of(&MessagePayload::Mail(mail.clone())), Some((Channel::Email, "a@example.com".to_string(), "body text".to_string())));

        mail.text_body = None;
        assert_eq!(route_of(&MessagePayload::Mail(mail)), Some((Channel::Email, "a@example.com".to_string(), "Hello".to_string())), "no text_body falls back to the subject");
    }
}
