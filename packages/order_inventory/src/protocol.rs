//! Best-effort project-owner notifications through the CanisterHub protocol.

use candid::{CandidType, Principal};
use serde::Deserialize;

pub async fn verify_project_package_membership(
    project_id: String,
    package_id: Principal,
    protocol_id: Principal,
) -> Result<bool, String> {
    let response =
        ic_cdk::call::Call::bounded_wait(protocol_id, "verify_project_package_membership")
            .with_args(&(project_id.clone(), package_id))
            .await
            .map_err(|error| format!("protocol membership verification call failed: {error:?}"))?;
    let result: Result<bool, String> = response
        .candid()
        .map_err(|error| format!("invalid protocol membership response: {error}"))?;
    ic_cdk::api::debug_print(format!(
        "order_inventory: protocol membership verification project_id={project_id} package_id={package_id} member={}",
        result.as_ref().copied().unwrap_or(false)
    ));
    result
}

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

#[derive(CandidType, Deserialize)]
struct OutboundMessage {
    session_id: String,
    text: String,
    subject: Option<String>,
}

fn format_minor_amount(amount_minor: u64, currency: &str) -> String {
    let currency = currency.to_ascii_uppercase();
    let exponent = match currency.as_str() {
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW"
        | "PYG" | "RWF" | "UGX" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        _ => 2,
    };
    if exponent == 0 {
        return format!("{currency} {amount_minor}");
    }
    let scale = 10u64.pow(exponent);
    format!(
        "{currency} {}.{:0width$}",
        amount_minor / scale,
        amount_minor % scale,
        width = exponent as usize
    )
}

pub async fn send_payment_receipt(
    agent: Principal,
    order: &crate::Order,
    payment: &crate::PaymentRecord,
) -> Result<(), String> {
    let item_lines = order.items.iter().take(10).map(|item| {
        let name: String = item.name.chars().filter(|character| !character.is_control()).take(120).collect();
        format!("{} × {}", item.quantity, name)
    }).collect::<Vec<_>>().join("\n");
    let remaining = order.items.len().saturating_sub(10);
    let more_items = if remaining > 0 { format!("\n…and {remaining} more item(s)") } else { String::new() };
    let provider = payment.provider.as_deref().unwrap_or("Payment provider");
    let transaction_id = payment.provider_transaction_id.as_deref().unwrap_or("not supplied");
    let text = format!(
        "Payment confirmed for order #{}\n\nReceipt\n{}{}\nTotal paid: {}\nPayment provider: {}\nReceipt reference: {}\nOrder reference: {}\n\nThe vendor has been notified and will update your order shortly.",
        order.id,
        item_lines,
        more_items,
        format_minor_amount(payment.amount_paid_minor, &payment.currency),
        provider,
        transaction_id,
        payment.merchant_reference,
    );
    let message = OutboundMessage {
        session_id: order.customer.session_id.clone(),
        text,
        subject: Some(format!("Payment receipt for order #{}", order.id)),
    };
    let response = ic_cdk::call::Call::bounded_wait(agent, "send_message")
        .with_args(&(message,))
        .await
        .map_err(|error| format!("agent send_message call failed: {error:?}"))?;
    let result: Result<(), String> = response
        .candid()
        .map_err(|error| format!("invalid agent send_message response: {error}"))?;
    result
}
