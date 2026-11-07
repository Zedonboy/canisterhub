//! Client for the shared Payment Provider API. Provider-specific packages
//! expose the same `create_charge` method so inventory does not depend on
//! Kora, Stripe, Paystack, or regional API details.

use candid::{CandidType, Principal};
use serde::Deserialize;

#[derive(Clone, Debug, CandidType)]
pub struct CreateChargeRequest {
    pub order_id: u64,
    /// Inventory canister that owns the order and exposes `record_payment`.
    pub inventory_canister: Principal,
    pub merchant_reference: String,
    pub amount_minor: u64,
    pub currency: String,
    pub customer_email: String,
    pub customer_name: Option<String>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct Charge {
    pub provider: String,
    pub reference: String,
    pub checkout_url: String,
    pub status: String,
}

pub async fn create_charge(
    payment_canister: Principal,
    request: CreateChargeRequest,
) -> Result<Charge, String> {
    ic_cdk::api::debug_print(format!(
        "order_inventory: payment create_charge started processor={payment_canister} order_id={}",
        request.order_id
    ));
    let response = ic_cdk::call::Call::bounded_wait(payment_canister, "create_charge")
        .with_args(&(request.clone(),))
        .await
        .map_err(|error| format!("payment provider call failed: {error:?}"))?;
    let result: Result<Charge, String> = response
        .candid()
        .map_err(|error| format!("invalid payment provider response: {error}"))?;
    let charge = result?;
    if !charge.checkout_url.starts_with("https://") {
        return Err("payment provider returned a non-HTTPS checkout URL".to_string());
    }
    ic_cdk::api::debug_print(format!(
        "order_inventory: payment checkout created provider={} order_id={} reference={}",
        charge.provider, request.order_id, charge.reference
    ));
    Ok(charge)
}
