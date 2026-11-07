use crate::http::{header, HttpRequest};
use crate::messages::TelegramMessage;

pub fn verify_secret(req: &HttpRequest, token: &str) -> bool {
    header(&req.headers, "X-Telegram-Bot-Api-Secret-Token") == Some(token)
}

pub fn parse_update(body: &[u8]) -> Result<Option<TelegramMessage>, String> {
    let root: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let update_id = root["update_id"].as_i64().ok_or("missing update_id")?;
    let msg = [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
    ]
    .iter()
    .map(|key| &root[key])
    .find(|v| !v.is_null());
    let Some(msg) = msg else { return Ok(None) };
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
        latitude: msg["location"]["latitude"].as_f64(),
        longitude: msg["location"]["longitude"].as_f64(),
        date: msg["date"].as_i64(),
        raw: root.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shared_location() {
        let body = br#"{"update_id":1,"message":{"message_id":2,"chat":{"id":3},"location":{"latitude":6.5244,"longitude":3.3792}}}"#;
        let message = parse_update(body).unwrap().unwrap();
        assert_eq!(message.latitude, Some(6.5244));
        assert_eq!(message.longitude, Some(3.3792));
    }
}
