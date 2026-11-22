use crate::http::{ct_eq, header, HttpRequest};
use crate::messages::TelegramMessage;

pub fn verify_secret(req: &HttpRequest, token: &str) -> bool {
    header(&req.headers, "X-Telegram-Bot-Api-Secret-Token").is_some_and(|got| ct_eq(got, token))
}

pub fn parse_update(body: &[u8]) -> Result<Option<TelegramMessage>, String> {
    let root: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let update_id = root["update_id"].as_i64().ok_or("missing update_id")?;
    // Only fresh messages from people in a private chat. Edits would re-run
    // the agent on text it already answered, channel posts and group chats
    // have no single customer (a group's `chat_id` would merge every member
    // into one conversation), and bots must never be answered (reply loops).
    let msg = &root["message"];
    if msg.is_null()
        || msg["chat"]["type"].as_str().is_some_and(|t| t != "private")
        || msg["from"]["is_bot"].as_bool() == Some(true)
    {
        return Ok(None);
    }
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
    fn ignores_edits_channel_posts_groups_and_bots() {
        for body in [
            r#"{"update_id":1,"edited_message":{"message_id":2,"chat":{"id":3,"type":"private"},"text":"hi"}}"#,
            r#"{"update_id":1,"channel_post":{"message_id":2,"chat":{"id":3,"type":"channel"},"text":"hi"}}"#,
            r#"{"update_id":1,"message":{"message_id":2,"chat":{"id":-3,"type":"supergroup"},"text":"hi"}}"#,
            r#"{"update_id":1,"message":{"message_id":2,"chat":{"id":3,"type":"private"},"from":{"id":9,"is_bot":true},"text":"hi"}}"#,
        ] {
            assert!(parse_update(body.as_bytes()).unwrap().is_none(), "{body}");
        }
        let ok = br#"{"update_id":1,"message":{"message_id":2,"chat":{"id":3,"type":"private"},"from":{"id":3,"is_bot":false},"text":"hi"}}"#;
        assert!(parse_update(ok).unwrap().is_some());
    }

    #[test]
    fn parses_shared_location() {
        let body = br#"{"update_id":1,"message":{"message_id":2,"chat":{"id":3},"location":{"latitude":6.5244,"longitude":3.3792}}}"#;
        let message = parse_update(body).unwrap().unwrap();
        assert_eq!(message.latitude, Some(6.5244));
        assert_eq!(message.longitude, Some(3.3792));
    }
}
