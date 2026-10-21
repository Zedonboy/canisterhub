//! Every runtime parameter this canister needs, in one candid record -
//! passed whole to `init` (see `lib.rs`) and read back whole by `get_config`.
//!
//! All fields are optional: a channel with unset fields simply can't be used
//! yet (its webhook returns `503`, `send_message` returns an `Err` naming
//! the missing field) rather than the canister refusing to install without
//! every integration configured up front.
//!
//! `update_config` takes a separate `ConfigUpdate`, not a whole `Config` -
//! one setter per field would be a lot of near-identical methods, but a
//! single method that replaces the whole record forces every caller to
//! `get_config` first just to avoid clobbering fields it doesn't mean to
//! touch. `ConfigUpdate` splits the difference: one method, but each of its
//! fields is independently optional, so a call only needs to name the
//! field(s) it actually wants to change.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    /// The principal allowed to call `receive_mail` - `mail_bridge`'s own
    /// identity (see `services/mail_bridge/README.md`).
    pub mail_bridge_principal: Option<Principal>,
    /// The principal allowed to call `send_message` - e.g. this project's
    /// `orchestrator`, or whatever else is driving conversations through
    /// this connector. A controller may always call `send_message`
    /// regardless of this setting (see `lib.rs::require_authorized_sender`).
    pub authorized_sender: Option<Principal>,

    /// The token Meta's `GET /webhook/whatsapp` verification handshake must
    /// present as `hub.verify_token` - see `whatsapp::verify_handshake`.
    pub whatsapp_verify_token: Option<String>,
    /// The WhatsApp app secret `X-Hub-Signature-256` is HMAC-SHA256'd with -
    /// see `whatsapp::verify_signature`. Not the same value as the verify
    /// token above.
    pub whatsapp_app_secret: Option<String>,
    /// Bearer token for the WhatsApp Cloud API's `POST .../messages` send
    /// call - a permanent (System User) access token from the Meta
    /// developer console, used by `send_message`.
    pub whatsapp_access_token: Option<String>,
    /// The business phone number id `send_message` posts to
    /// (`https://graph.facebook.com/<version>/<this>/messages>`) - found on
    /// the same console page as the access token above, not the phone
    /// number itself.
    pub whatsapp_phone_number_id: Option<String>,

    /// The `secret_token` passed to Telegram's `setWebhook` call - Telegram
    /// echoes it back as `X-Telegram-Bot-Api-Secret-Token` on every
    /// delivery; see `telegram::verify_secret`.
    pub telegram_secret_token: Option<String>,
    /// The bot token `send_message` authenticates
    /// `https://api.telegram.org/bot<this>/sendMessage` calls with (the same
    /// token `setWebhook` itself was called through).
    pub telegram_bot_token: Option<String>,

    /// Base URL of a `mail_bridge` deployment's HTTP API (e.g.
    /// `https://mail-bridge.example.com`, no trailing slash needed) -
    /// `send_message` posts to `<this>/send_mail`.
    pub mail_bridge_url: Option<String>,
    /// The bearer token `mail_bridge`'s `POST /send_mail` requires
    /// (`MAIL_BRIDGE_API_KEY` in its own config).
    pub mail_bridge_api_key: Option<String>,
    /// The `From:` address `send_message` sends outbound mail as.
    pub mail_from_address: Option<String>,

    /// A canister to forward every successfully-stored inbound message to,
    /// via that canister's own `receive_message(record { channel; session_id; text })`
    /// candid method (e.g. this project's `agent`) - see
    /// `forward_to_agent`. Best-effort: a failed or unconfigured forward
    /// never affects the webhook's/`receive_mail`'s own response, since the
    /// message is already durably stored either way.
    pub agent_canister: Option<Principal>,
}

/// `update_config`'s argument: one field per `Config` field, each wrapped in
/// an *extra* layer of `Option` beyond `Config`'s own - so every field has
/// three states, not two:
/// - outer `None` ("not mentioned"): leave this field exactly as it is.
/// - outer `Some(None)`: clear this field to `None`.
/// - outer `Some(Some(value))`: set this field to `value`.
///
/// Without that extra layer, a field's own `None` would be ambiguous
/// between "don't touch this" and "clear it" - the two need different
/// representations. `#[derive(Default)]` gives every field `None` (leave
/// everything alone), so `ConfigUpdate { authorized_sender: Some(Some(p)), ..Default::default() }`
/// changes only the one field named.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub mail_bridge_principal: Option<Option<Principal>>,
    pub authorized_sender: Option<Option<Principal>>,
    pub whatsapp_verify_token: Option<Option<String>>,
    pub whatsapp_app_secret: Option<Option<String>>,
    pub whatsapp_access_token: Option<Option<String>>,
    pub whatsapp_phone_number_id: Option<Option<String>>,
    pub telegram_secret_token: Option<Option<String>>,
    pub telegram_bot_token: Option<Option<String>>,
    pub mail_bridge_url: Option<Option<String>>,
    pub mail_bridge_api_key: Option<Option<String>>,
    pub mail_from_address: Option<Option<String>>,
    pub agent_canister: Option<Option<Principal>>,
}

impl Config {
    /// Applies `update` on top of `self`, field by field, per
    /// `ConfigUpdate`'s three-state doc comment.
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.mail_bridge_principal {
            self.mail_bridge_principal = v;
        }
        if let Some(v) = update.authorized_sender {
            self.authorized_sender = v;
        }
        if let Some(v) = update.whatsapp_verify_token {
            self.whatsapp_verify_token = v;
        }
        if let Some(v) = update.whatsapp_app_secret {
            self.whatsapp_app_secret = v;
        }
        if let Some(v) = update.whatsapp_access_token {
            self.whatsapp_access_token = v;
        }
        if let Some(v) = update.whatsapp_phone_number_id {
            self.whatsapp_phone_number_id = v;
        }
        if let Some(v) = update.telegram_secret_token {
            self.telegram_secret_token = v;
        }
        if let Some(v) = update.telegram_bot_token {
            self.telegram_bot_token = v;
        }
        if let Some(v) = update.mail_bridge_url {
            self.mail_bridge_url = v;
        }
        if let Some(v) = update.mail_bridge_api_key {
            self.mail_bridge_api_key = v;
        }
        if let Some(v) = update.mail_from_address {
            self.mail_from_address = v;
        }
        if let Some(v) = update.agent_canister {
            self.agent_canister = v;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    #[test]
    fn default_update_changes_nothing() {
        let config = Config {
            mail_bridge_principal: Some(principal(1)),
            whatsapp_verify_token: Some("token".to_string()),
            ..Default::default()
        };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn some_none_clears_a_field_without_touching_others() {
        let config = Config {
            mail_bridge_principal: Some(principal(1)),
            whatsapp_verify_token: Some("token".to_string()),
            ..Default::default()
        };
        let updated = config.apply(ConfigUpdate { whatsapp_verify_token: Some(None), ..Default::default() });
        assert_eq!(updated.whatsapp_verify_token, None);
        assert_eq!(updated.mail_bridge_principal, Some(principal(1)), "unrelated fields must be untouched");
    }

    #[test]
    fn some_some_sets_a_field_without_touching_others() {
        let config = Config { mail_bridge_principal: Some(principal(1)), ..Default::default() };
        let updated = config.apply(ConfigUpdate { authorized_sender: Some(Some(principal(2))), ..Default::default() });
        assert_eq!(updated.authorized_sender, Some(principal(2)));
        assert_eq!(updated.mail_bridge_principal, Some(principal(1)), "unrelated fields must be untouched");
    }

    #[test]
    fn every_field_is_independently_settable() {
        let update = ConfigUpdate {
            mail_bridge_principal: Some(Some(principal(1))),
            authorized_sender: Some(Some(principal(2))),
            whatsapp_verify_token: Some(Some("a".to_string())),
            whatsapp_app_secret: Some(Some("b".to_string())),
            whatsapp_access_token: Some(Some("c".to_string())),
            whatsapp_phone_number_id: Some(Some("d".to_string())),
            telegram_secret_token: Some(Some("e".to_string())),
            telegram_bot_token: Some(Some("f".to_string())),
            mail_bridge_url: Some(Some("g".to_string())),
            mail_bridge_api_key: Some(Some("h".to_string())),
            mail_from_address: Some(Some("i".to_string())),
            agent_canister: Some(Some(principal(3))),
        };
        let updated = Config::default().apply(update);
        assert_eq!(
            updated,
            Config {
                mail_bridge_principal: Some(principal(1)),
                authorized_sender: Some(principal(2)),
                whatsapp_verify_token: Some("a".to_string()),
                whatsapp_app_secret: Some("b".to_string()),
                whatsapp_access_token: Some("c".to_string()),
                whatsapp_phone_number_id: Some("d".to_string()),
                telegram_secret_token: Some("e".to_string()),
                telegram_bot_token: Some("f".to_string()),
                mail_bridge_url: Some("g".to_string()),
                mail_bridge_api_key: Some("h".to_string()),
                mail_from_address: Some("i".to_string()),
                agent_canister: Some(principal(3)),
            }
        );
    }
}
