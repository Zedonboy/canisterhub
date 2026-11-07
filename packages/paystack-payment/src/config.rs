use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, DynamicConfig)]
#[config_links(("Transactions", "/admin/", Admin))]
pub struct Config {
    #[config(
        label = "Project ID",
        description = "Project registry ID used to send verified payment notifications to the owner",
        group = "protocol",
        group_label = "Protocol Notifications"
    )]
    pub project_id: Option<String>,

    #[config(
        label = "Protocol Canister",
        description = "CanisterHub protocol used to route project web push notifications",
        default = "ibrml-ld777-77774-qaabq-cai",
        canister_picker(module_type = "protocol"),
        group = "protocol"
    )]
    pub protocol_id: Option<Principal>,

    #[config(
        label = "Trusted Canister List",
        description = "Canisters explicitly allowed to create charges. Other callers are accepted only when the protocol verifies that both this payment package and the caller belong to the configured project.",
        canister_picker,
        group = "protocol"
    )]
    pub trusted_canisters: Vec<Principal>,

    #[config(
        label = "Paystack Secret Key",
        description = "Paystack merchant secret key used only by this payment canister for server-side checkout and verification",
        secret,
        group = "paystack",
        group_label = "Paystack Payments"
    )]
    pub paystack_secret_key: Option<String>,

    #[config(
        label = "Webhook Signing Secret",
        description = "Optional Paystack webhook signing secret (whsec_...). Used to verify the timestamped Paystack-Signature header. Legacy x-paystack-signature webhooks use the Secret Key.",
        secret,
        group = "paystack"
    )]
    pub paystack_webhook_secret: Option<String>,

    #[config(
        label = "IC HTTP Base URL",
        description = "Generated from this canister ID. Copy this URL when configuring Paystack redirect and webhook settings.",
        readonly,
        group = "paystack"
    )]
    pub ic_http_url: Option<String>,

}

pub fn base_url() -> String {
    format!("https://{}.icp0.io", crate::ic_cdk::api::canister_self())
}

