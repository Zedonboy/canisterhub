mod config;
mod state;

use canister_hub_sdk::ic::config::{CanisterLink, ConfigFieldSchema, ConfigValue};
pub use canister_hub_sdk::{ProjectCanister, ProjectContext};
use ic_cdk::{init, post_upgrade, pre_upgrade};
use ic_certified_assets::types::Permission;
use std::cell::RefCell;
use std::collections::HashMap;

use crate::state::{
    is_candid_stable_state, load_candid_stable_state, load_stable_state, save_stable_state,
};

thread_local! {
    static PROJECT_CONTEXT: RefCell<Option<ProjectContext>> = const { RefCell::new(None) };
}

fn set_project_context(context: Option<ProjectContext>) {
    PROJECT_CONTEXT.with(|stored| *stored.borrow_mut() = context);
}

fn project_context() -> Option<ProjectContext> {
    PROJECT_CONTEXT.with(|stored| stored.borrow().clone())
}

#[init]
fn init(project_context: ProjectContext) {
    let installing_controller = ic_cdk::api::msg_caller();

    ic_certified_assets::init(None);
    set_project_context(Some(project_context));

    // Seed the dynamic permission configuration with the installing controller.
    ic_certified_assets::with_state_mut(|state| {
        state.grant_permission(installing_controller, &Permission::ManagePermissions);
    });
}

#[pre_upgrade]
fn pre_upgrade() {
    let stable_state = ic_certified_assets::pre_upgrade();
    save_stable_state(&stable_state, project_context()).expect("failed to serialize stable state");
}

#[post_upgrade]
fn post_upgrade() {
    let (stable_state, context) = if is_candid_stable_state() {
        // Backward compatibility with asset canisters that used Candid state.
        (
            load_candid_stable_state()
                .expect("failed to restore candid stable state")
                .into(),
            None,
        )
    } else {
        load_stable_state().expect("failed to deserialize stable state")
    };
    set_project_context(context);
    ic_certified_assets::post_upgrade(stable_state, None);
}

#[ic_cdk::query]
fn get_config_schema() -> Vec<ConfigFieldSchema> {
    config::schema()
}

#[ic_cdk::query]
fn get_config() -> HashMap<String, ConfigValue> {
    config::get()
}

#[ic_cdk::update]
fn set_config(settings: HashMap<String, ConfigValue>) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err("only a controller may change configuration".to_string());
    }
    config::set(settings)
}

#[ic_cdk::query]
fn get_links() -> Vec<CanisterLink> {
    config::links()
}

#[ic_cdk::query]
fn get_project_context() -> Result<Option<ProjectContext>, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err("only a controller may read project context".to_string());
    }
    Ok(project_context())
}

ic_certified_assets::export_canister_methods!();
