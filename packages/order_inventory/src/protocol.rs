//! Best-effort project-owner notifications through the CanisterHub protocol.

use candid::{CandidType, Principal};
use serde::Deserialize;

#[derive(CandidType, Deserialize)]
struct PushNotification {
    title: String,
    body: String,
    url: String,
}

#[derive(CandidType, Deserialize)]
struct PushDelivery {
    status: Option<u16>,
    endpoint: String,
    error: Option<String>,
    subscription_removed: bool,
}

async fn notify_owner(project_id: String, protocol_id: Principal, notification: PushNotification) {
    let response = ic_cdk::call::Call::bounded_wait(protocol_id, "send_project_notification")
        .with_args(&(project_id, notification))
        .await;
    match response {
        Err(error) => ic_cdk::api::debug_print(format!(
            "order_inventory: protocol notification call failed: {error:?}"
        )),
        Ok(response) => match response.candid::<Result<Vec<PushDelivery>, String>>() {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => ic_cdk::api::debug_print(format!(
                "order_inventory: protocol notification refused: {error}"
            )),
            Err(error) => ic_cdk::api::debug_print(format!(
                "order_inventory: invalid protocol notification response: {error}"
            )),
        },
    }
}

pub fn notify_new_order(order: &crate::Order) {
    let Some(project_id) = canister_hub_sdk::ic::config::get_env_text("project_id") else {
        return;
    };
    let Some(protocol_id) = canister_hub_sdk::ic::config::get_env_principal("protocol_id") else {
        return;
    };
    let notification = PushNotification {
        title: "New order".to_string(),
        body: format!("Order #{} has been placed", order.id),
        url: "/admin/".to_string(),
    };
    ic_cdk::futures::spawn(async move {
        notify_owner(project_id, protocol_id, notification).await;
    });
}
