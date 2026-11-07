use candid::{CandidType, Deserialize, Principal};

#[derive(Clone, CandidType)]
pub struct CreateChargeRequest {
    pub order_id: u64,
    pub inventory_canister: Principal,
    pub merchant_reference: String,
    pub amount_minor: u64,
    pub currency: String,
    pub customer_email: String,
    pub customer_name: Option<String>,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Charge {
    pub provider: String,
    pub reference: String,
    pub checkout_url: String,
    pub status: String,
}

pub async fn create_charge(
    canister: Principal,
    input: CreateChargeRequest,
) -> Result<Charge, String> {
    let response = ic_cdk::call::Call::bounded_wait(canister, "create_charge")
        .with_args(&(input,))
        .await
        .map_err(|error| format!("payment provider call failed: {error:?}"))?;
    let result: Result<Charge, String> = response
        .candid()
        .map_err(|error| format!("invalid payment provider response: {error}"))?;
    let charge = result?;
    if !charge.checkout_url.starts_with("https://") {
        return Err("payment provider returned a non-HTTPS checkout URL".to_string());
    }
    Ok(charge)
}
