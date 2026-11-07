//! The dashboard-facing config surface (`get_config_schema`/`get_config`/
//! `set_config`, `get_links`) every Marketplace Module exposes.
//!
//! The declared links expose both embedded webpages (`assets.rs`).
//! `storage_canister` is where the inventory UI uploads product/service
//! images. Storefront branding is configured here too. These values are
//! emitted into the embedded UIs' certified `ic_env` cookie (see `assets.rs`).
//! `project_id` and the defaulted `protocol_id` let order placement notify the
//! project owner without exposing a notification-canister dependency.

use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, DynamicConfig)]
#[config_links(
    ("Inventory Admin", "/admin/", Admin),
    ("Storefront", "/", Public)
)]
pub struct Config {
    #[config(
        label = "Project ID",
        description = "Project registry ID used to authorize protocol notification calls",
        group = "protocol",
        group_label = "Protocol",
        group_description = "Defaults used to notify the project owner about new orders"
    )]
    pub project_id: Option<String>,

    #[config(
        label = "Protocol Canister",
        description = "CanisterHub protocol that authorizes and routes project notifications",
        default = "ibrml-ld777-77774-qaabq-cai",
        canister_picker(module_type = "protocol"),
        group = "protocol"
    )]
    pub protocol_id: Option<Principal>,

    #[config(
        label = "Payment Processor Canister",
        description = "Payment provider package implementing the standard Payment Provider API (for example kora-payment.wasm or paystack-payment.wasm)",
        canister_picker,
        group = "payments",
        group_label = "Payments"
    )]
    pub payment_canister: Option<Principal>,

    #[config(
        label = "Storage Canister ID",
        description = "Asset-storage canister the inventory UI uploads product and service images to",
        canister_type = "storage",
        package_name = "assetstorage.wasm"
    )]
    pub storage_canister: Option<Principal>,

    #[config(
        label = "Business Name",
        description = "Business name shown in the public storefront header",
        group = "storefront_branding",
        group_label = "Storefront Branding",
        group_description = "Customize the name and logo shown to storefront customers"
    )]
    pub storefront_business_name: Option<String>,

    #[config(
        label = "Logo URL",
        description = "Public HTTPS image URL shown as the storefront logo",
        group = "storefront_branding"
    )]
    pub storefront_logo_url: Option<String>,

    #[config(
        label = "Custom Domains",
        description = "Enter one domain per line without https://, paths, or ports. The canister publishes them at /.well-known/ic-domains.",
        multiline,
        group = "custom_domains",
        group_label = "Custom Domains",
        group_description = "Domains that the IC HTTP gateway may route to this storefront"
    )]
    pub ic_domains: Option<String>,
}

pub fn apply_project_context(context: &canister_hub_sdk::ProjectContext) -> Result<(), String> {
    canister_hub_sdk::ic::config::update_project_context::<Config>(context)
}
