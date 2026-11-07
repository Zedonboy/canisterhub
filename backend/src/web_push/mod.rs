//! Backend-owned Web Push subscriptions and delivery.

mod push;
mod state;

use candid::Principal;
use ic_cdk::management_canister::raw_rand;
use serde::{Deserialize, Serialize};

use crate::{PushDelivery, PushNotification, PushSubscription};

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_KEY_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 200;
const MAX_BODY_BYTES: usize = 4 * 1_024;
const MAX_URL_BYTES: usize = 2_048;
const MAX_SUBSCRIPTIONS: usize = 32;
const VAPID_SUBJECT: &str = "mailto:support@canisterhub.app";

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
struct VapidConfig {
    private_key: Vec<u8>,
    subject: String,
}

// CandidType is imported separately to keep the public backend Candid surface
// in lib.rs while this module owns only persisted implementation details.
use candid::CandidType;

pub async fn ensure_vapid() -> Result<Vec<u8>, String> {
    let current = state::vapid_config();
    if !current.private_key.is_empty() {
        return push::public_key(&current.private_key);
    }
    let private_key = raw_rand()
        .await
        .map_err(|error| format!("raw_rand failed while generating VAPID key: {error}"))?;
    let public_key = push::public_key(&private_key)?;
    match state::initialize_vapid(VapidConfig {
        private_key,
        subject: VAPID_SUBJECT.to_string(),
    }) {
        Ok(()) => Ok(public_key),
        // Another concurrent caller may have initialized it while raw_rand
        // was awaited. Return the already-persisted public key in that case.
        Err(_) => push::public_key(&state::vapid_config().private_key),
    }
}

pub fn public_key() -> Result<Vec<u8>, String> {
    let config = state::vapid_config();
    if config.private_key.is_empty() {
        return Err("Web Push VAPID is not initialized".to_string());
    }
    push::public_key(&config.private_key)
}

pub fn subscribe(principal: Principal, subscription: PushSubscription) -> Result<(), String> {
    ensure_text_size("endpoint", &subscription.endpoint, MAX_ENDPOINT_BYTES)?;
    ensure_text_size("p256dh", &subscription.p256dh, MAX_KEY_BYTES)?;
    ensure_text_size("auth", &subscription.auth, MAX_KEY_BYTES)?;
    push::validate_subscription(
        &subscription.endpoint,
        &subscription.p256dh,
        &subscription.auth,
    )?;
    state::subscribe(principal, subscription, MAX_SUBSCRIPTIONS)
}

pub fn unsubscribe(principal: Principal, endpoint: &str) -> Result<(), String> {
    ensure_text_size("endpoint", endpoint, MAX_ENDPOINT_BYTES)?;
    state::unsubscribe(principal, endpoint);
    Ok(())
}

pub fn list(principal: &Principal) -> Vec<PushSubscription> {
    state::list(principal)
}

pub async fn send(
    principal: Principal,
    notification: PushNotification,
) -> Result<Vec<PushDelivery>, String> {
    if principal == Principal::anonymous() {
        return Err("notification recipient must not be anonymous".to_string());
    }
    ensure_text_size("notification title", &notification.title, MAX_TITLE_BYTES)?;
    ensure_text_size("notification body", &notification.body, MAX_BODY_BYTES)?;
    ensure_text_size("notification URL", &notification.url, MAX_URL_BYTES)?;

    let subscriptions = state::list(&principal);
    if subscriptions.is_empty() {
        return Ok(Vec::new());
    }
    let config = state::vapid_config();
    if config.private_key.is_empty() {
        return Err("Web Push VAPID is not initialized".to_string());
    }
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
