use candid::Principal;
use canister_hub_sdk::ic::config::{
    CanisterLink, CanisterType, ConfigFieldSchema, ConfigType, ConfigValue, ConfigVectorType,
    ConfigVectorValue,
};
use ic_certified_assets::types::{Permission, SetPermissions};
use std::collections::HashMap;

const PREPARE: &str = "prepare_permissions";
const COMMIT: &str = "commit_permissions";
const MANAGE: &str = "manage_permissions";

fn field(key: &str, label: &str, description: &str) -> ConfigFieldSchema {
    ConfigFieldSchema {
        key: key.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        group: Some("asset_permissions".to_string()),
        group_label: Some("Asset Permissions".to_string()),
        group_description: Some(
            "Choose which principals may prepare, commit, or manage asset uploads.".to_string(),
        ),
        field_type: ConfigType::Vector {
            element_type: ConfigVectorType::CanisterPicker {
                module_type_filter: None,
            },
        },
        canister_type: Some(CanisterType::Custom),
        package_name: None,
        is_required: false,
        is_readonly: Some(false),
        default_value: Some(ConfigValue::Vector(Vec::new())),
    }
}

pub fn schema() -> Vec<ConfigFieldSchema> {
    vec![
        field(
            PREPARE,
            "Prepare Uploads",
            "Principals allowed to create upload batches and chunks",
        ),
        field(
            COMMIT,
            "Commit Uploads",
            "Principals allowed to commit prepared assets",
        ),
        field(
            MANAGE,
            "Manage Permissions",
            "Principals allowed to grant and revoke asset permissions",
        ),
    ]
}

fn principals(permission: Permission) -> Vec<Principal> {
    ic_certified_assets::with_state(|state| {
        state.list_permitted(&permission).iter().copied().collect()
    })
}

fn value(permission: Permission) -> ConfigValue {
    ConfigValue::Vector(
        principals(permission)
            .into_iter()
            .map(ConfigVectorValue::PrincipalId)
            .collect(),
    )
}

pub fn get() -> HashMap<String, ConfigValue> {
    HashMap::from([
        (PREPARE.to_string(), value(Permission::Prepare)),
        (COMMIT.to_string(), value(Permission::Commit)),
        (MANAGE.to_string(), value(Permission::ManagePermissions)),
    ])
}

fn decode(key: &str, value: &ConfigValue) -> Result<Vec<Principal>, String> {
    let ConfigValue::Vector(values) = value else {
        return Err(format!("config key '{key}' expects a Vector value"));
    };
    let mut principals = Vec::with_capacity(values.len());
    for value in values {
        let ConfigVectorValue::PrincipalId(principal) = value else {
            return Err(format!("config key '{key}' only accepts principal IDs"));
        };
        if !principals.contains(principal) {
            principals.push(*principal);
        }
    }
    Ok(principals)
}

pub fn set(settings: HashMap<String, ConfigValue>) -> Result<(), String> {
    for key in settings.keys() {
        if !matches!(key.as_str(), PREPARE | COMMIT | MANAGE) {
            return Err(format!("unknown config key '{key}'"));
        }
    }
    let current = get();
    let selected = |key: &str| -> Result<Vec<Principal>, String> {
        decode(key, settings.get(key).unwrap_or(&current[key]))
    };
    let prepare = selected(PREPARE)?;
    let commit = selected(COMMIT)?;
    let mut manage_permissions = selected(MANAGE)?;
    let caller = ic_cdk::api::msg_caller();
    if !manage_permissions.contains(&caller) {
        manage_permissions.push(caller);
    }
    ic_certified_assets::with_state_mut(|state| {
        state.set_permissions(SetPermissions {
            prepare,
            commit,
            manage_permissions,
        });
    });
    Ok(())
}

pub fn links() -> Vec<CanisterLink> {
    Vec::new()
}
