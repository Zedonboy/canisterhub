mod state;

use ic_cdk::{init, post_upgrade, pre_upgrade};
use ic_certified_assets::types::{AssetCanisterArgs, Permission};

use crate::state::{
    is_candid_stable_state, load_candid_stable_state, load_stable_state, save_stable_state,
};

#[init]
fn init(args: Option<AssetCanisterArgs>) {
    let installing_controller = ic_cdk::api::msg_caller();

    ic_certified_assets::init(args);

    // The install caller is a controller. Granting this permission explicitly
    // also keeps it when InitArgs::set_permissions replaces all permission lists.
    ic_certified_assets::with_state_mut(|state| {
        state.grant_permission(installing_controller, &Permission::ManagePermissions);
    });
}

#[pre_upgrade]
fn pre_upgrade() {
    let stable_state = ic_certified_assets::pre_upgrade();
    save_stable_state(&stable_state).expect("failed to serialize stable state");
}

#[post_upgrade]
fn post_upgrade(args: Option<AssetCanisterArgs>) {
    let stable_state = if is_candid_stable_state() {
        // Backward compatibility with asset canisters that used Candid state.
        load_candid_stable_state()
            .expect("failed to restore candid stable state")
            .into()
    } else {
        load_stable_state().expect("failed to deserialize stable state")
    };
    ic_certified_assets::post_upgrade(stable_state, args);
}

ic_certified_assets::export_canister_methods!();
