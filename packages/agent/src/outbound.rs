use crate::config::Config;
use crate::telegram_format;
use crate::messages::{Channel, ClientDataKind, ClientDataRequest, OutboundMessage, SessionKey};
use ic_cdk_management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

pub async fn reply_to_customer(
    config: &Config,
    customer: &SessionKey,
    text: &str,
) -> Result<(), String> {
    send(
        config,
        &OutboundMessage {
            channel: customer.channel,
            session_id: customer.session_id.clone(),
            text: text.to_string(),
            subject: None,
        },
    )
    .await
}

/// Renders a pending model-created request using the current channel's best
/// client control. Web reads the request through Candid; the other adapters
/// deliver it immediately after the assistant's normal reply.
pub async fn send_client_data_request(
    config: &Config,
    customer: &SessionKey,
    request: &ClientDataRequest,
) -> Result<(), String> {
    match customer.channel {
        Channel::Web => Ok(()),
        Channel::WhatsApp => {
            let token = config
                .whatsapp_access_token
                .as_deref()
                .ok_or("whatsapp_access_token is not configured")?;
            let phone = config
                .whatsapp_phone_number_id
                .as_deref()
                .ok_or("whatsapp_phone_number_id is not configured")?;
            let body = if request.kind == ClientDataKind::Location {
                serde_json::json!({
                    "messaging_product": "whatsapp",
                    "to": customer.session_id,
                    "type": "interactive",
                    "interactive": {
                        "type": "location_request_message",
                        "body": { "text": request.prompt },
                        "action": { "name": "send_location" }
                    }
                })
            } else {
                serde_json::json!({
                    "messaging_product": "whatsapp",
                    "to": customer.session_id,
                    "type": "text",
                    "text": { "body": request.prompt }
                })
            };
            post_json(
                &format!("https://graph.facebook.com/v21.0/{phone}/messages"),
                &[("Authorization".into(), format!("Bearer {token}"))],
                body,
            )
            .await
        }
        Channel::Telegram => {
            let token = config
                .telegram_bot_token
                .as_deref()
                .ok_or("telegram_bot_token is not configured")?;
            let chat_id: i64 = customer
                .session_id
                .parse()
                .map_err(|_| "invalid Telegram chat id".to_string())?;
            let mut body = serde_json::json!({"chat_id": chat_id, "text": request.prompt});
            if request.kind == ClientDataKind::Location {
                body["reply_markup"] = serde_json::json!({
                    "keyboard": [[{ "text": "Share my location", "request_location": true }]],
                    "resize_keyboard": true,
                    "one_time_keyboard": true
                });
            }
            post_json(
                &format!("https://api.telegram.org/bot{token}/sendMessage"),
                &[],
                body,
            )
            .await
        }
        Channel::Email => {
            send(
                config,
                &OutboundMessage {
                    channel: Channel::Email,
                    session_id: customer.session_id.clone(),
                    text: request.prompt.clone(),
                    subject: Some("Information needed".to_string()),
                },
            )
            .await
        }
    }
}

pub async fn send(config: &Config, msg: &OutboundMessage) -> Result<(), String> {
    crate::log_info(format!(
        "outbound delivery started channel={:?} chars={}",
        msg.channel,
        msg.text.chars().count()
    ));
    let result = match msg.channel {
        // Web customers read their reply from stored history (`web_messages`);
        // there is no endpoint to push to.
        Channel::Web => Ok(()),
        Channel::WhatsApp => {
            let token = config
                .whatsapp_access_token
                .as_deref()
                .ok_or("whatsapp_access_token is not configured")?;
            let phone = config
                .whatsapp_phone_number_id
                .as_deref()
                .ok_or("whatsapp_phone_number_id is not configured")?;
            post_json(&format!("https://graph.facebook.com/v21.0/{phone}/messages"), &[("Authorization".into(), format!("Bearer {token}"))], serde_json::json!({"messaging_product":"whatsapp","to":msg.session_id,"type":"text","text":{"body":msg.text}})).await
        }
        Channel::Telegram => {
            let token = config
                .telegram_bot_token
                .as_deref()
                .ok_or("telegram_bot_token is not configured")?;
            let chat_id: i64 = msg
                .session_id
                .parse()
                .map_err(|_| "invalid Telegram chat id".to_string())?;
            // Replies are markdown from the model; Telegram only renders the
            // HTML subset `telegram_format` produces, and caps messages at
            // 4096 characters, so a long reply goes out as several messages.
            let url = format!("https://api.telegram.org/bot{token}/sendMessage");
            let mut result = Ok(());
            for chunk in telegram_format::render(&msg.text) {
                result = send_telegram_chunk(&url, chat_id, &chunk).await;
                if result.is_err() {
                    break;
                }
            }
            result
        }
        Channel::Email => {
            let base = config
                .mail_bridge_url
                .as_deref()
                .ok_or("mail_bridge_url is not configured")?;
            let key = config
                .mail_bridge_api_key
                .as_deref()
                .ok_or("mail_bridge_api_key is not configured")?;
            let from = config
                .mail_from_address
                .as_deref()
                .ok_or("mail_from_address is not configured")?;
            post_json(&format!("{}/send_mail", base.trim_end_matches('/')), &[("Authorization".into(), format!("Bearer {key}"))], serde_json::json!({"from":from,"to":[msg.session_id],"subject":msg.subject.clone().unwrap_or_else(|| "Message".into()),"text_body":msg.text})).await
        }
    };
    match &result {
        Ok(()) => crate::log_info(format!(
            "outbound delivery completed channel={:?}",
            msg.channel
        )),
        Err(error) => crate::log_error(format!(
            "outbound delivery failed channel={:?}: {error}",
            msg.channel
        )),
    }
    result
}

/// Shows "typing…" in a Telegram chat for about five seconds (or until the
/// next message is sent). Best-effort: callers log and ignore failures.
pub async fn telegram_typing(config: &Config, chat_id: i64) -> Result<(), String> {
    let token = config
        .telegram_bot_token
        .as_deref()
        .ok_or("telegram_bot_token is not configured")?;
    post_json(
        &format!("https://api.telegram.org/bot{token}/sendChatAction"),
        &[],
        serde_json::json!({"chat_id": chat_id, "action": "typing"}),
    )
    .await
}

/// Sends one chunk as formatted HTML, falling back to its plain text if
/// Telegram answers 400 (e.g. "can't parse entities") so a conversion
/// problem costs the formatting, never the message.
async fn send_telegram_chunk(
    url: &str,
    chat_id: i64,
    chunk: &telegram_format::Chunk,
) -> Result<(), String> {
    if chunk.is_html {
        let body = serde_json::json!({"chat_id": chat_id, "text": chunk.html, "parse_mode": "HTML"});
        match post_json(url, &[], body).await {
            Err(e) if e.contains("status 400") => {
                crate::log_warn("Telegram rejected formatted text; resending as plain text");
            }
            other => return other,
        }
    }
    post_json(url, &[], serde_json::json!({"chat_id": chat_id, "text": chunk.plain})).await
}

/// Points Telegram's webhook for `token`'s bot at `url`. Errors never include
/// the token (it is part of the request URL).
pub async fn telegram_set_webhook(
    token: &str,
    url: &str,
    secret_token: Option<&str>,
) -> Result<(), String> {
    // Only plain messages are ever handled (see `telegram::parse_update`), so
    // don't have Telegram deliver edits, channel posts or anything else.
    let mut body = serde_json::json!({"url": url, "allowed_updates": ["message"]});
    if let Some(secret) = secret_token {
        body["secret_token"] = serde_json::json!(secret);
    }
    post_json(&format!("https://api.telegram.org/bot{token}/setWebhook"), &[], body).await
}

async fn post_json(
    url: &str,
    extra: &[(String, String)],
    body: serde_json::Value,
) -> Result<(), String> {
    let mut headers = vec![HttpHeader {
        name: "Content-Type".into(),
        value: "application/json".into(),
    }];
    headers.extend(
        extra
            .iter()
            .cloned()
            .map(|(name, value)| HttpHeader { name, value }),
    );
    let response = http_request(&HttpRequestArgs {
        url: url.into(),
        method: HttpMethod::POST,
        headers,
        body: Some(body.to_string().into_bytes()),
        max_response_bytes: Some(4_096),
        transform: None,
        is_replicated: Some(false),
    })
    .await
    // Do not include `url` in this error: Telegram embeds its bot token in
    // the URL, and callers may record this error in canister logs.
    .map_err(|e| format!("outbound HTTP call failed: {e:?}"))?;
    if response.status != 200u32 {
        return Err(format!(
            "outbound HTTP service returned status {}",
            response.status
        ));
    }
    Ok(())
}
