use crate::http::{header, path_and_query, query_param, HttpRequest, HttpResponse};
use crate::messages::WhatsAppMessage;
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn verify_handshake(req: &HttpRequest, configured_token: &str) -> HttpResponse {
    let (_, query) = path_and_query(&req.url);
    match (
        query_param(query, "hub.mode").as_deref(),
        query_param(query, "hub.verify_token"),
        query_param(query, "hub.challenge"),
    ) {
        (Some("subscribe"), Some(token), Some(challenge)) if token == configured_token => {
            HttpResponse::text(200, challenge)
        }
        _ => HttpResponse::text(403, "verification failed"),
    }
}

pub fn verify_signature(body: &[u8], signature: Option<&str>, secret: &str) -> bool {
    let Some(hex_sig) = signature.and_then(|h| h.strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

pub fn header_signature(req: &HttpRequest) -> Option<&str> {
    header(&req.headers, "X-Hub-Signature-256")
}

pub fn parse_messages(body: &[u8]) -> Result<Vec<WhatsAppMessage>, String> {
    let root: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let mut out = Vec::new();
    for entry in root["entry"].as_array().into_iter().flatten() {
        for change in entry["changes"].as_array().into_iter().flatten() {
            let value = &change["value"];
            let to = value["metadata"]["display_phone_number"]
                .as_str()
                .map(str::to_string);
            for msg in value["messages"].as_array().into_iter().flatten() {
                out.push(WhatsAppMessage {
                    message_id: msg["id"].as_str().unwrap_or_default().to_string(),
                    from: msg["from"].as_str().unwrap_or_default().to_string(),
                    to: to.clone(),
                    message_type: msg["type"].as_str().unwrap_or("unknown").to_string(),
                    text: msg["text"]["body"].as_str().map(str::to_string),
                    timestamp: msg["timestamp"].as_str().map(str::to_string),
                    raw: msg.to_string(),
                });
            }
        }
    }
    Ok(out)
}
