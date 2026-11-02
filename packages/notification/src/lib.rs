//! Project-owned Web Push notification module.
//!
//! Browsers manage their own subscriptions directly. Controllers initialize
//! the module's VAPID identity, while controllers and explicitly trusted
//! project canisters may deliver notifications.

getrandom::register_custom_getrandom!(unreachable_getrandom);
fn unreachable_getrandom(_buffer: &mut [u8]) -> Result<(), getrandom::Error> {
    ic_cdk::trap(
        "unexpected local randomness request; notification cryptographic randomness must come from IC raw_rand",
    )
}

mod config;
mod push;
mod state;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::{CandidType, Principal};
use ic_cdk::management_canister::raw_rand;
use serde::{Deserialize, Serialize};

const MAX_PUSH_ENDPOINT_BYTES: usize = 2_048;
const MAX_PUSH_KEY_BYTES: usize = 256;
const MAX_PUSH_SUBJECT_BYTES: usize = 512;
const MAX_PUSH_TITLE_BYTES: usize = 200;
const MAX_PUSH_BODY_BYTES: usize = 4 * 1_024;
const MAX_PUSH_URL_BYTES: usize = 2_048;
const MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL: usize = 32;

canister_hub_sdk::ic::metadata::canister_metadata!(
    name = "notification",
    description = "Project-owned Web Push subscriptions, encryption, and delivery.",
    canister_type = "custom",
    version = "1.0.0",
);

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
pub struct PushSubscriptions(pub Vec<PushSubscription>);

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
pub struct PushVapidConfig {
    pub(crate) private_key: Vec<u8>,
    pub(crate) subject: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    pub url: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushDelivery {
    pub endpoint: String,
    pub status: Option<u16>,
    pub error: Option<String>,
    pub subscription_removed: bool,
}

fn require_controller() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err("only a controller may call this".to_string())
    }
}

fn require_authenticated_caller(action: &str) -> Result<Principal, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        Err(format!("anonymous callers may not {action}"))
    } else {
        Ok(caller)
    }
}

fn require_sender() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if ic_cdk::api::is_controller(&caller) || config::is_trusted_sender(&caller) {
        Ok(())
    } else {
        Err("only a controller or trusted sender may deliver notifications".to_string())
    }
}

fn ensure_text_size(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        Err(format!(
            "{label} is too large ({} bytes; maximum {max})",
            value.len()
        ))
    } else {
        Ok(())
    }
}

fn init_config() {
    canister_hub_sdk::ic::config::init_stable_store::<config::Config>(
        state::dynamic_config_memory(),
    );
}

#[ic_cdk::init]
fn init() {
    init_config();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_config();
}

#[ic_cdk::update]
async fn push_init_vapid(subject: String) -> Result<Vec<u8>, String> {
    require_controller()?;
    ensure_text_size("VAPID subject", &subject, MAX_PUSH_SUBJECT_BYTES)?;
    push::validate_subject(&subject)?;
    if !state::vapid_config().private_key.is_empty() {
        return Err("Web Push VAPID is already initialized".to_string());
    }
    let private_key = raw_rand()
        .await
        .map_err(|error| format!("raw_rand failed while generating VAPID key: {error}"))?;
    let public_key = push::public_key(&private_key)?;
    state::initialize_vapid(PushVapidConfig {
        private_key,
        subject,
    })?;
    Ok(public_key)
}

#[ic_cdk::update]
fn push_import_vapid(private_key: String, subject: String) -> Result<Vec<u8>, String> {
    require_controller()?;
    ensure_text_size("VAPID private key", &private_key, MAX_PUSH_KEY_BYTES)?;
    ensure_text_size("VAPID subject", &subject, MAX_PUSH_SUBJECT_BYTES)?;
    push::validate_subject(&subject)?;
    let private_key = push::decode_private_key(&private_key)?;
    let public_key = push::public_key(&private_key)?;
    state::initialize_vapid(PushVapidConfig {
        private_key,
        subject,
    })?;
    Ok(public_key)
}

#[ic_cdk::query]
fn push_vapid_public_key() -> Result<Vec<u8>, String> {
    let config = state::vapid_config();
    if config.private_key.is_empty() {
        return Err("Web Push VAPID is not initialized".to_string());
    }
    push::public_key(&config.private_key)
}

#[ic_cdk::update]
fn push_subscribe(subscription: PushSubscription) -> Result<(), String> {
    let principal = require_authenticated_caller("subscribe to push notifications")?;
    ensure_text_size("endpoint", &subscription.endpoint, MAX_PUSH_ENDPOINT_BYTES)?;
    ensure_text_size("p256dh", &subscription.p256dh, MAX_PUSH_KEY_BYTES)?;
    ensure_text_size("auth", &subscription.auth, MAX_PUSH_KEY_BYTES)?;
    push::validate_subscription(
        &subscription.endpoint,
        &subscription.p256dh,
        &subscription.auth,
    )?;
    state::subscribe(
        principal,
        subscription,
        MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL,
    )
}

#[ic_cdk::update]
fn push_unsubscribe(endpoint: String) -> Result<(), String> {
    let principal = require_authenticated_caller("unsubscribe from push notifications")?;
    ensure_text_size("endpoint", &endpoint, MAX_PUSH_ENDPOINT_BYTES)?;
    state::unsubscribe(principal, &endpoint);
    Ok(())
}

#[ic_cdk::query]
fn push_list_subscriptions() -> Result<Vec<PushSubscription>, String> {
    let principal = require_authenticated_caller("list push subscriptions")?;
    Ok(state::list(&principal))
}

#[ic_cdk::update]
async fn push_send(
    principal: Principal,
    notification: PushNotification,
) -> Result<Vec<PushDelivery>, String> {
    require_sender()?;
    if principal == Principal::anonymous() {
        return Err("notification recipient must not be anonymous".to_string());
    }
    ensure_text_size(
        "notification title",
        &notification.title,
        MAX_PUSH_TITLE_BYTES,
    )?;
    ensure_text_size("notification body", &notification.body, MAX_PUSH_BODY_BYTES)?;
    ensure_text_size("notification URL", &notification.url, MAX_PUSH_URL_BYTES)?;

    let config = state::vapid_config();
    if config.private_key.is_empty() {
        return Err("Web Push VAPID is not initialized".to_string());
    }
    let subscriptions = state::list(&principal);
    let payload = push::NotificationPayload {
        title: &notification.title,
        body: &notification.body,
        url: &notification.url,
    };
    let mut deliveries = Vec::with_capacity(subscriptions.len());
    for subscription in subscriptions {
        let result = match push::prepare(
            &config.private_key,
            &config.subject,
            &subscription.endpoint,
            &subscription.p256dh,
            &subscription.auth,
            &payload,
        )
        .await
        {
            Ok(prepared) => push::deliver(prepared).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(status) if (200..300).contains(&status) => deliveries.push(PushDelivery {
                endpoint: subscription.endpoint,
                status: Some(status),
                error: None,
                subscription_removed: false,
            }),
            Ok(status) => {
                let removed = matches!(status, 404 | 410)
                    && state::remove_if_unchanged(principal, &subscription);
                deliveries.push(PushDelivery {
                    endpoint: subscription.endpoint,
                    status: Some(status),
                    error: Some(format!("push service returned HTTP {status}")),
                    subscription_removed: removed,
                });
            }
            Err(error) => deliveries.push(PushDelivery {
                endpoint: subscription.endpoint,
                status: None,
                error: Some(error),
                subscription_removed: false,
            }),
        }
    }
    Ok(deliveries)
}

/// Public operational check that does not expose private key material.
#[ic_cdk::query]
fn push_is_initialized() -> bool {
    !state::vapid_config().private_key.is_empty()
}

/// Base64url form is useful for non-browser clients without exposing secrets.
#[ic_cdk::query]
fn push_vapid_public_key_base64() -> Result<String, String> {
    push_vapid_public_key().map(|key| URL_SAFE_NO_PAD.encode(key))
}

ic_cdk::export_candid!();
