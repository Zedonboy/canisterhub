//! Dashboard-managed allowlist for canisters permitted to deliver pushes.

use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, DynamicConfig)]
pub struct Config {
    #[config(
        label = "Trusted Senders",
        description = "Canisters allowed to send notifications to this module's subscribers",
        canister_picker
    )]
    pub trusted_senders: Vec<Principal>,
}

pub fn is_trusted_sender(principal: &Principal) -> bool {
    canister_hub_sdk::ic::config::get_env_vector("trusted_senders")
        .unwrap_or_default()
        .into_iter()
        .any(|value| matches!(value, canister_hub_sdk::ic::config::ConfigVectorValue::PrincipalId(id) if id == *principal))
}
