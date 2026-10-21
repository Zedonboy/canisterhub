//! WhatsApp Cloud API webhook handling: the GET verification handshake Meta
//! performs once when a webhook URL is configured, `X-Hub-Signature-256`
//! HMAC-SHA256 verification of every subsequent POST, and parsing the
//! Cloud API's payload shape into `WhatsAppMessage`s.
//!
//! Reference: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
//! and https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks

use crate::http::{header, path_and_query, query_param, HttpRequest, HttpResponse};
use crate::messages::WhatsAppMessage;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Handles the one-time `GET` verification handshake: Meta calls the webhook
/// URL with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`
/// query params, and expects `hub.challenge` echoed back verbatim (as plain
/// text, `200`) if `hub.verify_token` matches what was configured when the
/// webhook was set up in the Meta developer console - otherwise the
/// subscription attempt must be rejected.
pub fn verify_handshake(req: &HttpRequest, configured_token: &str) -> HttpResponse {
    let (_, query) = path_and_query(&req.url);
    let mode = query_param(query, "hub.mode");
    let token = query_param(query, "hub.verify_token");
    let challenge = query_param(query, "hub.challenge");

    match (mode.as_deref(), token, challenge) {
        (Some("subscribe"), Some(token), Some(challenge)) if token == configured_token => HttpResponse::text(200, challenge),
        _ => HttpResponse::text(403, "verification failed"),
    }
}

/// Verifies the `X-Hub-Signature-256: sha256=<hex hmac>` header Meta signs
/// every webhook delivery with, keyed by the app secret (not the verify
/// token above - a different secret, configured in the same console page).
/// This is the actual authenticity check for POSTed webhook bodies; the
/// verify token above only gates *subscribing* the webhook URL in the first
/// place, per `canister-security`'s guidance that HTTP endpoints can't rely
/// on caller identity and must verify payloads cryptographically instead.
pub fn verify_signature(body: &[u8], signature_header: Option<&str>, app_secret: &str) -> bool {
    let Some(hex_sig) = signature_header.and_then(|h| h.strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(app_secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    // `verify_slice` compares in constant time - unlike a plain `==` on the
    // decoded bytes, which would leak timing information about how many
    // leading bytes matched.
    mac.verify_slice(&expected).is_ok()
}

pub fn header_signature(req: &HttpRequest) -> Option<&str> {
    header(&req.headers, "X-Hub-Signature-256")
}

/// Unpacks every `messages[]` entry across a webhook payload's
/// `entry[].changes[].value.messages[]` (there is almost always exactly one,
/// but the shape allows batching). Entries that aren't a message the
/// business account received (e.g. a delivery-status update) live alongside
/// `messages` under `statuses` and are ignored here - `receive_mail`'s
/// analog for those would be a different candid method if this connector
/// ever needs delivery receipts, not something to fold into message storage.
pub fn parse_messages(body: &[u8]) -> Result<Vec<WhatsAppMessage>, String> {
    let root: serde_json::Value = serde_json::from_slice(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let mut out = Vec::new();

    for entry in root["entry"].as_array().into_iter().flatten() {
        for change in entry["changes"].as_array().into_iter().flatten() {
            let value = &change["value"];
            let display_number = value["metadata"]["display_phone_number"].as_str().map(str::to_string);
            for msg in value["messages"].as_array().into_iter().flatten() {
                out.push(WhatsAppMessage {
                    message_id: msg["id"].as_str().unwrap_or_default().to_string(),
                    from: msg["from"].as_str().unwrap_or_default().to_string(),
                    to: display_number.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str) -> HttpRequest {
        HttpRequest { method: "GET".to_string(), url: url.to_string(), headers: vec![], body: vec![] }
    }

    #[test]
    fn verify_handshake_echoes_challenge_when_token_matches() {
        let r = req("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=1234");
        let resp = verify_handshake(&r, "secret");
        assert_eq!(resp.status_code, 200);
        assert_eq!(String::from_utf8(resp.body).unwrap(), "1234");
    }

    #[test]
    fn verify_handshake_rejects_wrong_token() {
        let r = req("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234");
        assert_eq!(verify_handshake(&r, "secret").status_code, 403);
    }

    #[test]
    fn verify_handshake_rejects_missing_params() {
        let r = req("/webhook/whatsapp?hub.mode=subscribe");
        assert_eq!(verify_handshake(&r, "secret").status_code, 403);
    }

    #[test]
    fn verify_signature_accepts_correct_hmac_and_rejects_tampering() {
        let body = b"{\"hello\":\"world\"}";
        let secret = "app-secret";
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        let sig = hex::encode(mac.finalize().into_bytes());
        let header = format!("sha256={sig}");

        assert!(verify_signature(body, Some(&header), secret));
        assert!(!verify_signature(b"tampered body", Some(&header), secret));
        assert!(!verify_signature(body, Some(&header), "wrong-secret"));
        assert!(!verify_signature(body, None, secret));
        assert!(!verify_signature(body, Some("not-even-hex-prefixed"), secret));
    }

    #[test]
    fn parse_messages_extracts_text_message_and_display_number() {
        let payload = serde_json::json!({
            "entry": [{
                "changes": [{
                    "value": {
                        "metadata": { "display_phone_number": "15551234567" },
                        "messages": [{
                            "id": "wamid.abc123",
                            "from": "15557654321",
                            "type": "text",
                            "timestamp": "1700000000",
                            "text": { "body": "hello there" }
                        }]
                    }
                }]
            }]
        });
        let messages = parse_messages(payload.to_string().as_bytes()).unwrap();
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.message_id, "wamid.abc123");
        assert_eq!(m.from, "15557654321");
        assert_eq!(m.to.as_deref(), Some("15551234567"));
        assert_eq!(m.message_type, "text");
        assert_eq!(m.text.as_deref(), Some("hello there"));
        assert_eq!(m.timestamp.as_deref(), Some("1700000000"));
    }

    #[test]
    fn parse_messages_ignores_status_only_payloads() {
        let payload = serde_json::json!({
            "entry": [{ "changes": [{ "value": { "statuses": [{"id": "wamid.x", "status": "delivered"}] } }] }]
        });
        assert!(parse_messages(payload.to_string().as_bytes()).unwrap().is_empty());
    }

    #[test]
    fn parse_messages_rejects_invalid_json() {
        assert!(parse_messages(b"not json").is_err());
    }
}
