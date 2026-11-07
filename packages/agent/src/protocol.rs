//! CanisterHub protocol identity used by managed platform services.
//!
//! This is compiled into the package instead of exposed as an SME setting.
//! Replace this one value with the permanent protocol principal before a
//! mainnet package release.

use candid::{CandidType, Principal};
use serde::Deserialize;

pub const PROTOCOL_CANISTER_ID: &str = "ibrml-ld777-77774-qaabq-cai";

pub fn canister_id() -> Result<Principal, String> {
    Principal::from_text(PROTOCOL_CANISTER_ID)
        .map_err(|error| format!("compiled protocol canister ID is invalid: {error}"))
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

/// Best-effort owner notification routed through the protocol. Missing
/// project configuration or delivery failures never fail customer messaging.
pub async fn notify_owner(config: &crate::Config, title: &str, body: &str, url: &str) {
    let Some(project_id) = config.project_id.as_deref() else {
        return;
    };
    let protocol = match config.protocol_id.map(Ok).unwrap_or_else(canister_id) {
        Ok(id) => id,
        Err(error) => {
            crate::log_error(error);
            return;
        }
    };
    let notification = PushNotification {
        title: title.to_string(),
        body: body.chars().take(500).collect(),
        url: url.to_string(),
    };
    let response = ic_cdk::call::Call::bounded_wait(protocol, "send_project_notification")
        .with_args(&(project_id.to_string(), notification))
        .await;
    match response {
        Err(error) => crate::log_error(format!("protocol notification call failed: {error:?}")),
        Ok(response) => match response.candid::<Result<Vec<PushDelivery>, String>>() {
            Ok(Ok(deliveries)) => crate::log_info(format!(
                "project owner notification completed deliveries={}",
                deliveries.len()
            )),
            Ok(Err(error)) => crate::log_warn(format!("protocol notification refused: {error}")),
            Err(error) => crate::log_error(format!(
                "protocol notification response was invalid: {error}"
            )),
        },
    }
}
