use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, DynamicConfig)]
#[config_links(
    ("Restaurant Admin", "/admin/", Admin),
    ("Restaurant Storefront", "/", Public)
)]
pub struct Config {
    #[config(
        label = "Project ID",
        description = "Project ID used to verify calling agents and send project notifications",
        group = "protocol",
        group_label = "Protocol"
    )]
    pub project_id: Option<String>,

    #[config(
        label = "Protocol Canister",
        description = "CanisterHub backend used for project membership verification and owner notifications",
        default = "ibrml-ld777-77774-qaabq-cai",
        canister_picker(module_type = "protocol"),
        group = "protocol"
    )]
    pub protocol_id: Option<Principal>,

    #[config(
        label = "Payment Processor",
        description = "Configured payment package used for prepaid checkout",
        canister_picker,
        group = "payments",
        group_label = "Payments"
    )]
    pub payment_canister: Option<Principal>,

    #[config(
        label = "Storage Canister",
        description = "Asset-storage canister for restaurant menu photos",
        canister_type = "storage",
        package_name = "assetstorage.wasm",
        group = "storefront",
        group_label = "Storefront"
    )]
    pub storage_canister: Option<Principal>,
}
