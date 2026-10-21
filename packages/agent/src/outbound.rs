//! Relaying a reply back to the customer, via `connector::send_message` -
//! see that canister's README.md. This is the only outbound path in this
//! whole canister that reaches a customer directly (as opposed to
//! `admin.rs`'s webhook, which reaches an administrative system, never a
//! customer).

use crate::messages::{Channel as EngineChannel, SessionKey};
use candid::Principal;

/// Field-for-field identical to `connector`'s `Channel` candid type -
/// candid matches by shape, not by the two crates sharing a Rust type (see
/// `connector::messages::Channel`).
#[derive(candid::CandidType, serde::Serialize)]
enum ConnectorChannel {
    WhatsApp,
    Telegram,
    Email,
}

impl From<EngineChannel> for ConnectorChannel {
    fn from(c: EngineChannel) -> Self {
        match c {
            EngineChannel::WhatsApp => ConnectorChannel::WhatsApp,
            EngineChannel::Telegram => ConnectorChannel::Telegram,
            EngineChannel::Email => ConnectorChannel::Email,
        }
    }
}

/// Field-for-field identical to `connector`'s `OutboundMessage` candid type.
#[derive(candid::CandidType, serde::Serialize)]
struct ConnectorOutboundMessage {
    channel: ConnectorChannel,
    session_id: String,
    text: String,
    subject: Option<String>,
}

/// Sends `text` back to `customer` via `connector`'s `send_message`.
/// `connector_id` is `Config::connector_principal` - the same value already
/// used to authenticate `receive_message`'s caller, reused here as the
/// destination for the reply: `connector_principal` isn't a separately
/// derived identity the way `mail_bridge`'s is (see that canister's
/// README.md) - a canister's caller identity *is* its own canister id, so
/// "the principal allowed to call `receive_message`" and "the canister id
/// to call `send_message` on" are one and the same value.
pub async fn reply_to_customer(connector_id: Principal, customer: &SessionKey, text: &str) -> Result<(), String> {
    let msg = ConnectorOutboundMessage { channel: customer.channel.into(), session_id: customer.session_id.clone(), text: text.to_string(), subject: None };
    let response = ic_cdk::call::Call::bounded_wait(connector_id, "send_message")
        .with_arg(msg)
        .await
        .map_err(|e| format!("call to connector.send_message failed: {e:?}"))?;
    response.candid::<Result<(), String>>().map_err(|e| format!("failed to decode connector.send_message's response: {e}"))?
}
