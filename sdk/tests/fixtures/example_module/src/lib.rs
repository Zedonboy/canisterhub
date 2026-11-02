//! Fixture canister exercising every `#[dynamic_config]` field kind, for
//! `canister-hub-sdk`'s PocketIC integration test
//! (`../../config_endpoints.rs`). Not a real Marketplace Module.

use candid::Principal;
use canister_hub_sdk::ic::config::dynamic_config;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use ic_stable_structures::DefaultMemoryImpl;
use std::cell::RefCell;

#[dynamic_config]
#[config_links(
    (
        "Admin Panel",
        "https://{canister_id}.icp0.io/admin",
        Admin
    ),
    ("Home Page", "https://{canister_id}.icp0.io/", Public)
)]
pub struct ModuleConfig {
    #[config(
        label = "Greeting",
        default = "Hello!",
        group = "general",
        group_label = "General",
        group_description = "Basic module behavior"
    )]
    pub greeting: String,
    #[config(label = "Retry Count", group = "general")]
    pub retry_count: i64,
    #[config(label = "Threshold", default = 0.5)]
    pub threshold: f64,
    #[config(label = "Feature Enabled", default = true)]
    pub feature_enabled: bool,
    #[config(label = "API Key", secret)]
    pub api_key: Option<String>,
    #[config(label = "Tier", select(options = ["free", "pro"]), default = "free")]
    pub tier: String,
    #[config(label = "Upstream Canister", canister_picker)]
    pub upstream: Option<Principal>,
    #[config(label = "Auth Canister", canister_type = "auth")]
    pub auth_canister: Option<Principal>,
    #[config(label = "Allowed Origins")]
    pub allowed_origins: Vec<String>,
    #[config(label = "Operator Notes", multiline)]
    pub operator_notes: Option<String>,
    #[config(label = "Backup Canisters", canister_type = "storage")]
    pub backup_canisters: Vec<Principal>,
    #[config(
        label = "Build Hash",
        description = "Build identifier reported by the canister",
        readonly
    )]
    pub build_hash: String,
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
}

fn init_config() {
    canister_hub_sdk::ic::config::init_stable_store::<ModuleConfig>(
        MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(10))),
    );
    canister_hub_sdk::ic::config::set_readonly::<ModuleConfig>(
        "build_hash",
        canister_hub_sdk::ic::config::ConfigValue::Text("fixture-build-abc123".to_string()),
    )
    .expect("build_hash is a valid read-only config value");
}

#[ic_cdk::init]
fn init() {
    init_config();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_config();
}

/// Proves internal code can read mirrored config without touching Candid.
#[ic_cdk::query]
fn greet() -> String {
    canister_hub_sdk::ic::config::get_env_text("greeting").unwrap_or_default()
}

#[ic_cdk::query]
fn feature_enabled() -> bool {
    canister_hub_sdk::ic::config::get_env_bool("feature_enabled").unwrap_or_default()
}

ic_cdk::export_candid!();
