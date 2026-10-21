//! Telegram Bot API webhook handling: `X-Telegram-Bot-Api-Secret-Token`
//! verification (the `secret_token` param passed to `setWebhook`) and
//! parsing an `Update` object into a `TelegramMessage`.
//!
//! Unlike WhatsApp, Telegram has no separate GET verification handshake -
//! `setWebhook` is called once, out of band, from wherever the bot is
//! administered, and after that Telegram just POSTs `Update`s to the
//! configured URL with the secret token on every request.
//!
//! Reference: https://core.telegram.org/bots/api#setwebhook and
//! https://core.telegram.org/bots/api#update

use crate::http::{header, HttpRequest};
use crate::messages::TelegramMessage;

pub fn verify_secret(req: &HttpRequest, configured_token: &str) -> bool {
    header(&req.headers, "X-Telegram-Bot-Api-Secret-Token") == Some(configured_token)
}

/// Parses one `Update` object. Telegram's `Update` is a big variant covering
/// many event kinds (`message`, `edited_message`, `channel_post`,
/// `callback_query`, `my_chat_member`, …) of which only the message-like ones
/// carry a chat to reply to and are worth this connector storing - anything
/// else parses successfully as `Ok(None)` (still a `200` ack, since Telegram
/// retries deliveries that don't get one) rather than an error.
pub fn parse_update(body: &[u8]) -> Result<Option<TelegramMessage>, String> {
    let root: serde_json::Value = serde_json::from_slice(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let update_id = root["update_id"].as_i64().ok_or("missing update_id")?;

    let msg = ["message", "edited_message", "channel_post", "edited_channel_post"]
        .iter()
        .map(|key| &root[key])
        .find(|v| !v.is_null());

    let Some(msg) = msg else {
        return Ok(None);
    };

    let Some(chat_id) = msg["chat"]["id"].as_i64() else {
        return Ok(None);
    };

    Ok(Some(TelegramMessage {
        update_id,
        message_id: msg["message_id"].as_i64(),
        chat_id,
        from_user_id: msg["from"]["id"].as_i64(),
        from_username: msg["from"]["username"].as_str().map(str::to_string),
        text: msg["text"].as_str().map(str::to_string),
        date: msg["date"].as_i64(),
        raw: root.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_with_secret(secret: Option<&str>) -> HttpRequest {
        let headers = secret.map(|s| vec![("X-Telegram-Bot-Api-Secret-Token".to_string(), s.to_string())]).unwrap_or_default();
        HttpRequest { method: "POST".to_string(), url: "/webhook/telegram".to_string(), headers, body: vec![] }
    }

    #[test]
    fn verify_secret_matches_configured_value_only() {
        assert!(verify_secret(&req_with_secret(Some("abc")), "abc"));
        assert!(!verify_secret(&req_with_secret(Some("wrong")), "abc"));
        assert!(!verify_secret(&req_with_secret(None), "abc"));
    }

    #[test]
    fn parse_update_extracts_a_text_message() {
        let payload = serde_json::json!({
            "update_id": 42,
            "message": {
                "message_id": 7,
                "date": 1700000000,
                "chat": { "id": 12345 },
                "from": { "id": 999, "username": "alice" },
                "text": "hi there"
            }
        });
        let msg = parse_update(payload.to_string().as_bytes()).unwrap().expect("should parse a message");
        assert_eq!(msg.update_id, 42);
        assert_eq!(msg.message_id, Some(7));
        assert_eq!(msg.chat_id, 12345);
        assert_eq!(msg.from_user_id, Some(999));
        assert_eq!(msg.from_username.as_deref(), Some("alice"));
        assert_eq!(msg.text.as_deref(), Some("hi there"));
        assert_eq!(msg.date, Some(1700000000));
    }

    #[test]
    fn parse_update_falls_back_across_message_like_variants() {
        let payload = serde_json::json!({
            "update_id": 1,
            "channel_post": { "message_id": 2, "chat": { "id": -100 }, "text": "post" }
        });
        let msg = parse_update(payload.to_string().as_bytes()).unwrap().expect("should parse channel_post");
        assert_eq!(msg.chat_id, -100);
        assert_eq!(msg.text.as_deref(), Some("post"));
    }

    #[test]
    fn parse_update_returns_none_for_non_message_updates() {
        let payload = serde_json::json!({ "update_id": 1, "callback_query": { "id": "cb1" } });
        assert!(parse_update(payload.to_string().as_bytes()).unwrap().is_none());
    }

    #[test]
    fn parse_update_rejects_missing_update_id() {
        assert!(parse_update(b"{}").is_err());
    }

    #[test]
    fn parse_update_rejects_invalid_json() {
        assert!(parse_update(b"not json").is_err());
    }
}
