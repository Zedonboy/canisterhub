use crate::config::Config;
use crate::messages::{Channel, OutboundMessage, SessionKey};
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

pub async fn send(config: &Config, msg: &OutboundMessage) -> Result<(), String> {
    match msg.channel {
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
            post_json(
                &format!("https://api.telegram.org/bot{token}/sendMessage"),
                &[],
                serde_json::json!({"chat_id":chat_id,"text":msg.text}),
            )
            .await
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
    }
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
    .map_err(|e| format!("outcall to {url} failed: {e:?}"))?;
    if response.status != 200u32 {
        return Err(format!("{url} returned status {}", response.status));
    }
    Ok(())
}
