//! Standardized dynamic-config surface for Marketplace Module canisters:
//! `get_config_schema`/`get_config`/`set_config` Candid endpoints, stable-
//! memory persistence, and a process-local env mirror internal code can
//! read without touching Candid. IC-only (`ic` feature) - it needs
//! `ic-cdk` (for `set_config`'s controller check and the generated
//! `#[query]`/`#[update]` endpoints) and `ic-stable-structures` (for
//! persistence), neither of which the `client`/`browser` transports pull in.
//!
//! Annotate one struct with `#[dynamic_config]` (or
//! `#[derive(DynamicConfig)]` if you'd rather add your own derives) to get
//! all three endpoints generated:
//!
//! ```rust,ignore
//! use canister_hub_sdk::ic::config::dynamic_config;
//!
//! #[dynamic_config]
//! pub struct ModuleConfig {
//!     #[config(label = "Greeting", default = "Hello!")]
//!     pub greeting: String,
//!     #[config(label = "Retry count", default = 3)]
//!     pub retries: i64,
//!     #[config(label = "API key", secret)]
//!     pub api_key: Option<String>,
//!     #[config(label = "Build hash", readonly)]
//!     pub build_hash: Option<String>,
//! }
//!
//! # use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
//! # use ic_stable_structures::DefaultMemoryImpl;
//! # use std::cell::RefCell;
//! thread_local! {
//!     static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
//!         RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
//! }
//!
//! // Call from *both* #[init] and #[post_upgrade] with the same MemoryId -
//! // see `init_stable_store`'s doc comment for why this module can't just
//! // seize those hooks itself.
//! fn init_module_config() {
//!     canister_hub_sdk::ic::config::init_stable_store::<ModuleConfig>(
//!         MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(10))),
//!     );
//!     canister_hub_sdk::ic::config::set_readonly::<ModuleConfig>(
//!         "build_hash",
//!         canister_hub_sdk::ic::config::ConfigValue::Text("abc123".into()),
//!     ).expect("valid read-only config value");
//! }
//!
//! #[ic_cdk::init]
//! fn init() {
//!     init_module_config();
//! }
//!
//! #[ic_cdk::post_upgrade]
//! fn post_upgrade() {
//!     init_module_config();
//! }
//!
//! fn greet() -> String {
//!     canister_hub_sdk::ic::config::get_env_text("greeting").unwrap_or_default()
//! }
//! ```
//!
//! Use exactly one `#[dynamic_config]`/`#[derive(DynamicConfig)]`
//! struct per canister crate - the generated `get_config_schema`/
//! `get_config`/`set_config` are free functions, and a second one would
//! collide.
//!
//! ## Struct attributes
//!
//! - `#[config_urls(admin_panel_url = "...", home_page_url = "...")]` - see
//!   "Endpoint semantics" below.
//!
//! ## Field attributes
//!
//! All `#[config(...)]` items are optional.
//!
//! - `label = "..."` (defaults to the field name in Title Case, e.g. `retry_count` -> `"Retry Count"`)
//! - `description = "..."` (defaults to `""`)
//! - `key = "..."` (defaults to the field name)
//! - `default = <literal>` (marks the field optional; literal type must match the field)
//! - `secret` (`String`/`Option<String>` only -> `ConfigType::SecretText`, masked by `get_config` for non-controllers)
//! - `readonly` (shown to settings clients but rejected by `set_config`;
//!   canister code populates it with [`set_readonly`]). Combine it with
//!   `secret` when the value itself is sensitive.
//! - `select(options = ["a", "b"])` (`String`/`Option<String>` only -> `ConfigType::Select`; a `default` must be one of `options`)
//! - `canister_picker` or `canister_picker(module_type = "...")` (`Principal`/`Option<Principal>` only -> `ConfigType::CanisterPicker`)
//! - `canister_type = "auth" | "storage" | "database" | "custom"`
//!   (`Principal`/`Option<Principal>` only). This is typed metadata for a
//!   canister picker. If omitted, consumers must treat it as `custom`.
//!
//! Supported field types: `String`, `i64` (-> `Number`), `f64` (-> `Float`),
//! `bool` (-> `Boolean`), `candid::Principal` (-> `CanisterPicker`), and
//! `Option<T>` of any of those. `Option<T>` makes the field optional
//! (`is_required: false`) even without an explicit `default`; a bare
//! (non-`Option`) field with no `default` is `is_required: true`.
//!
//! ## Stable memory ownership
//!
//! This module never creates its own `MemoryManager` - two independent
//! `MemoryManager`s over the same stable memory would corrupt each other's
//! bucket tables (see [`crate::ic::storage`]'s doc comment for the same
//! rule applied to this crate's other stable-memory building blocks).
//! Instead you allocate one unused `MemoryId` from your canister's own
//! `MemoryManager` and pass the resulting `Memory` to
//! [`init_stable_store`] from your own `#[init]` and `#[post_upgrade]`.
//! That call is also what (re)fills the env mirror, which is how "mirror
//! into env on init/post_upgrade" is satisfied without this module seizing
//! hooks a canister may only have one of.
//!
//! Config is stored via `candid::encode_one`/`decode_one` (not ciborium):
//! the same `ConfigValue`/`HashMap` shape already defined for the public
//! interface is exactly what's on the stable heap, with no second wire
//! format to keep in sync. A field added in a later upgrade is filled in
//! from its schema default (if any) the next time `init_stable_store` runs;
//! a field with no default that was never set just stays absent until a
//! caller sets it.
//!
//! ## Endpoint semantics
//!
//! - `get_config_schema`/`get_config` are public queries.
//! - `set_config` is **controller-only** and validates before persisting:
//!   unknown keys, wrong-type values, and a `Select` value outside its
//!   `options`, as well as attempts to change a `readonly` field, are all
//!   rejected; the update is otherwise a **partial
//!   merge** (keys you don't mention keep their current value). After
//!   merging, every `is_required` field must be present in the result or
//!   the whole call is rejected - nothing is partially applied.
//! - `get_config` **masks `SecretText` fields** (`"••••••••"`) for any
//!   caller that isn't a controller, since a plain unauthenticated query is
//!   exactly the channel a settings UI reads it over. Internal code always
//!   sees the real value via the env mirror, which isn't caller-scoped.
//! - `get_admin_panel_url`/`get_home_page_url` are public queries returning
//!   `Option<String>`, `None` unless the struct declared a struct-level
//!   `#[config_urls(admin_panel_url = "...", home_page_url = "...")]`
//!   (either or both). A literal may contain the placeholder
//!   `{canister_id}`, substituted at call time with this canister's own
//!   principal (see [`resolve_url_template`]) - the common case, since a
//!   module's admin/home route is almost always `https://{canister_id}
//!   .icp0.io/...` rather than a fixed external URL.
//!
//! A canister's own self-declared identity (name/description/type) is a
//! separate, decoupled concern - see [`crate::ic::metadata`]'s
//! `canister_metadata!` macro, not this module.

use candid::{CandidType, Principal};
use ic_stable_structures::{
    memory_manager::VirtualMemory, storable::Bound, DefaultMemoryImpl, StableCell, Storable,
};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;

pub use canister_hub_sdk_macros::{dynamic_config, DynamicConfig};

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum ConfigType {
    Text,
    Number,
    Float,
    Boolean,
    Select {
        options: Vec<String>,
    },
    CanisterPicker {
        module_type_filter: Option<String>,
    },
    /// Same wire shape as `Text`; `get_config` masks the value for any
    /// caller that isn't a controller (see this module's doc comment).
    SecretText,
}

#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanisterType {
    Auth,
    Storage,
    Database,
    Custom,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum ConfigValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
}

impl ConfigValue {
    /// Name of the variant, for error messages (`"a Text value"` etc.).
    pub fn type_name(&self) -> &'static str {
        match self {
            ConfigValue::Text(_) => "Text",
            ConfigValue::Number(_) => "Number",
            ConfigValue::Float(_) => "Float",
            ConfigValue::Boolean(_) => "Boolean",
            ConfigValue::PrincipalId(_) => "PrincipalId",
        }
    }

    /// Whether this value is an acceptable instance of `field_type` (for
    /// `Select`, also checks membership in `options`).
    pub fn matches(&self, field_type: &ConfigType) -> bool {
        match (field_type, self) {
            (ConfigType::Text, ConfigValue::Text(_)) => true,
            (ConfigType::SecretText, ConfigValue::Text(_)) => true,
            (ConfigType::Number, ConfigValue::Number(_)) => true,
            (ConfigType::Float, ConfigValue::Float(_)) => true,
            (ConfigType::Boolean, ConfigValue::Boolean(_)) => true,
            (ConfigType::CanisterPicker { .. }, ConfigValue::PrincipalId(_)) => true,
            (ConfigType::Select { options }, ConfigValue::Text(value)) => {
                options.iter().any(|option| option == value)
            }
            _ => false,
        }
    }
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ConfigFieldSchema {
    pub key: String,
    pub label: String,
    pub description: String,
    pub field_type: ConfigType,
    /// Optional typed filter for canister-picker fields. `None` has the
    /// same meaning as `Some(CanisterType::Custom)`.
    pub canister_type: Option<CanisterType>,
    pub is_required: bool,
    /// `Some(true)` means this value is canister-provided display data and
    /// cannot be changed through `set_config`. Optional on the wire so new
    /// settings clients remain compatible with older module canisters.
    pub is_readonly: Option<bool>,
    pub default_value: Option<ConfigValue>,
}

impl ConfigFieldSchema {
    /// Returns the effective picker type. An omitted type deliberately
    /// resolves to `Custom`; non-picker fields have no canister type.
    pub fn resolved_canister_type(&self) -> Option<CanisterType> {
        matches!(self.field_type, ConfigType::CanisterPicker { .. })
            .then_some(self.canister_type.unwrap_or(CanisterType::Custom))
    }

    pub fn readonly(&self) -> bool {
        self.is_readonly.unwrap_or(false)
    }
}

/// Implemented by `#[derive(DynamicConfig)]` / `#[dynamic_config]` for
/// the annotated struct. The struct itself is never instantiated by this
/// module - it exists only to carry field types/attributes at compile time;
/// the actual runtime config lives in the `HashMap<String, ConfigValue>`
/// this trait and [`init_stable_store`]/[`get`]/[`set`] operate on.
pub trait ConfigSchema {
    fn schema() -> Vec<ConfigFieldSchema>;
    /// Only the fields that declared a `default_value`.
    fn defaults() -> HashMap<String, ConfigValue>;
}

struct StorableConfig(HashMap<String, ConfigValue>);

impl Storable for StorableConfig {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(
            candid::encode_one(&self.0).expect("canister_hub_sdk: failed to candid-encode config"),
        )
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        StorableConfig(
            candid::decode_one(bytes.as_ref())
                .expect("canister_hub_sdk: failed to candid-decode config"),
        )
    }
}

thread_local! {
    static STORE: RefCell<Option<StableCell<StorableConfig, Memory>>> = const { RefCell::new(None) };
    static ENV: RefCell<HashMap<String, ConfigValue>> = RefCell::new(HashMap::new());
}

const NOT_INITIALIZED: &str =
    "canister_hub_sdk: config store not initialized - call canister_hub_sdk::ic::config::init_stable_store in #[init] and #[post_upgrade]";

/// Loads (or, on a fresh canister, creates) the config stable cell on
/// `memory`, fills in any schema-declared default for a key the stored map
/// doesn't have yet (covers a field added by a later module upgrade), and
/// mirrors the result into the env (see [`get_env`] and friends). Call this
/// from both `#[init]` and `#[post_upgrade]` with the same `MemoryId`.
pub fn init_stable_store<T: ConfigSchema>(memory: Memory) {
    let cell = StableCell::init(memory, StorableConfig(T::defaults()));
    let mut merged = cell.get().0.clone();
    for (key, value) in T::defaults() {
        merged.entry(key).or_insert(value);
    }
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(existing) = s.as_mut() {
            existing.set(StorableConfig(merged.clone()));
        } else {
            let mut cell = cell;
            cell.set(StorableConfig(merged.clone()));
            *s = Some(cell);
        }
    });
    mirror_env(&merged);
}

fn mirror_env(map: &HashMap<String, ConfigValue>) {
    ENV.with(|e| *e.borrow_mut() = map.clone());
}

fn get_raw() -> HashMap<String, ConfigValue> {
    STORE.with(|s| s.borrow().as_ref().expect(NOT_INITIALIZED).get().0.clone())
}

fn persist(map: HashMap<String, ConfigValue>) {
    STORE.with(|store| {
        store
            .borrow_mut()
            .as_mut()
            .expect(NOT_INITIALIZED)
            .set(StorableConfig(map.clone()));
    });
    mirror_env(&map);
}

fn caller_is_controller() -> bool {
    ic_cdk::api::is_controller(&ic_cdk::api::msg_caller())
}

/// Masks every `SecretText` field's value unless the caller is a
/// controller - see this module's doc comment for why the masking has to
/// happen here, not client-side.
fn mask_secrets<T: ConfigSchema>(
    mut map: HashMap<String, ConfigValue>,
) -> HashMap<String, ConfigValue> {
    if caller_is_controller() {
        return map;
    }
    for field in T::schema() {
        if matches!(field.field_type, ConfigType::SecretText) && map.contains_key(&field.key) {
            map.insert(field.key, ConfigValue::Text("••••••••".to_string()));
        }
    }
    map
}

/// Backs the generated `get_config` query.
pub fn get<T: ConfigSchema>() -> HashMap<String, ConfigValue> {
    mask_secrets::<T>(get_raw())
}

/// Backs the generated `set_config` update: merges `new_settings` onto the
/// persisted map (unlisted keys are left as-is), rejects unknown keys and
/// type mismatches or read-only keys, requires every `is_required` field to
/// end up present, then persists and re-mirrors into env.
pub fn set<T: ConfigSchema>(new_settings: HashMap<String, ConfigValue>) -> Result<(), String> {
    let schema = T::schema();
    let schema_by_key: HashMap<&str, &ConfigFieldSchema> = schema
        .iter()
        .map(|field| (field.key.as_str(), field))
        .collect();

    for key in new_settings.keys() {
        if !schema_by_key.contains_key(key.as_str()) {
            return Err(format!("unknown config key '{key}'"));
        }
    }

    let mut merged = get_raw();
    for (key, value) in &new_settings {
        let field = schema_by_key[key.as_str()];
        if field.readonly() {
            return Err(format!("config key '{key}' is read-only"));
        }
        if !value.matches(&field.field_type) {
            return Err(format!(
                "config key '{key}' expects a {:?} value, got a {} value",
                field.field_type,
                value.type_name()
            ));
        }
        merged.insert(key.clone(), value.clone());
    }

    for field in &schema {
        if field.is_required && !merged.contains_key(&field.key) {
            return Err(format!("missing required config key '{}'", field.key));
        }
    }

    persist(merged);
    Ok(())
}

/// Sets a canister-owned display value declared with `#[config(readonly)]`.
///
/// This is a regular Rust function, not a generated Candid endpoint. Module
/// code can call it after [`init_stable_store`] when values such as a build
/// hash, generated identifier, or derived status change. Public
/// [`set_config`](set) callers cannot mutate the value.
pub fn set_readonly<T: ConfigSchema>(key: &str, value: ConfigValue) -> Result<(), String> {
    let field = T::schema()
        .into_iter()
        .find(|field| field.key == key)
        .ok_or_else(|| format!("unknown config key '{key}'"))?;
    if !field.readonly() {
        return Err(format!("config key '{key}' is not read-only"));
    }
    if !value.matches(&field.field_type) {
        return Err(format!(
            "config key '{key}' expects a {:?} value, got a {} value",
            field.field_type,
            value.type_name()
        ));
    }

    let mut config = get_raw();
    config.insert(key.to_string(), value);
    persist(config);
    Ok(())
}

/// Removes one optional setting from the persisted map. This is primarily
/// for compatibility endpoints that use nested options to distinguish
/// "leave unchanged" from "clear"; the public dynamic `set_config` endpoint
/// remains a partial merge.
pub fn unset<T: ConfigSchema>(key: &str) -> Result<(), String> {
    let field = T::schema()
        .into_iter()
        .find(|field| field.key == key)
        .ok_or_else(|| format!("unknown config key '{key}'"))?;
    if field.is_required {
        return Err(format!("required config key '{key}' cannot be cleared"));
    }
    if field.readonly() {
        return Err(format!("read-only config key '{key}' cannot be cleared"));
    }

    let mut config = get_raw();
    config.remove(key);
    persist(config);
    Ok(())
}

/// Substitutes the placeholder `{canister_id}` in `template` with this
/// canister's own principal (text form). Used by the generated
/// `get_admin_panel_url`/`get_home_page_url` when the struct declared
/// `#[config_urls(...)]` - see this module's doc comment.
pub fn resolve_url_template(template: &str) -> String {
    template.replace("{canister_id}", &ic_cdk::api::canister_self().to_text())
}

/// Runs `f` with read access to the full mirrored env map, for callers that
/// want more than one key without cloning the whole map per lookup.
pub fn with_env<R>(f: impl FnOnce(&HashMap<String, ConfigValue>) -> R) -> R {
    ENV.with(|e| f(&e.borrow()))
}

pub fn get_env(key: &str) -> Option<ConfigValue> {
    ENV.with(|e| e.borrow().get(key).cloned())
}

pub fn get_env_text(key: &str) -> Option<String> {
    match get_env(key) {
        Some(ConfigValue::Text(value)) => Some(value),
        _ => None,
    }
}

pub fn get_env_number(key: &str) -> Option<i64> {
    match get_env(key) {
        Some(ConfigValue::Number(value)) => Some(value),
        _ => None,
    }
}

pub fn get_env_float(key: &str) -> Option<f64> {
    match get_env(key) {
        Some(ConfigValue::Float(value)) => Some(value),
        _ => None,
    }
}

pub fn get_env_bool(key: &str) -> Option<bool> {
    match get_env(key) {
        Some(ConfigValue::Boolean(value)) => Some(value),
        _ => None,
    }
}

pub fn get_env_principal(key: &str) -> Option<Principal> {
    match get_env(key) {
        Some(ConfigValue::PrincipalId(value)) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestConfig;

    #[test]
    fn omitted_canister_type_resolves_to_custom() {
        let schema = ConfigFieldSchema {
            key: "upstream".to_string(),
            label: "Upstream".to_string(),
            description: String::new(),
            field_type: ConfigType::CanisterPicker {
                module_type_filter: None,
            },
            canister_type: None,
            is_required: false,
            is_readonly: None,
            default_value: None,
        };

        assert_eq!(schema.resolved_canister_type(), Some(CanisterType::Custom));
    }

    impl ConfigSchema for TestConfig {
        fn schema() -> Vec<ConfigFieldSchema> {
            vec![
                ConfigFieldSchema {
                    key: "greeting".to_string(),
                    label: "Greeting".to_string(),
                    description: String::new(),
                    field_type: ConfigType::Text,
                    canister_type: None,
                    is_required: false,
                    is_readonly: None,
                    default_value: Some(ConfigValue::Text("hello".to_string())),
                },
                ConfigFieldSchema {
                    key: "retries".to_string(),
                    label: "Retries".to_string(),
                    description: String::new(),
                    field_type: ConfigType::Number,
                    canister_type: None,
                    is_required: true,
                    is_readonly: None,
                    default_value: None,
                },
                ConfigFieldSchema {
                    key: "api_key".to_string(),
                    label: "API Key".to_string(),
                    description: String::new(),
                    field_type: ConfigType::SecretText,
                    canister_type: None,
                    is_required: false,
                    is_readonly: None,
                    default_value: None,
                },
                ConfigFieldSchema {
                    key: "build_hash".to_string(),
                    label: "Build Hash".to_string(),
                    description: String::new(),
                    field_type: ConfigType::Text,
                    canister_type: None,
                    is_required: false,
                    is_readonly: Some(true),
                    default_value: None,
                },
            ]
        }

        fn defaults() -> HashMap<String, ConfigValue> {
            let mut map = HashMap::new();
            map.insert(
                "greeting".to_string(),
                ConfigValue::Text("hello".to_string()),
            );
            map
        }
    }

    // Exercises `get_raw`/`set::<TestConfig>` directly (bypassing
    // `init_stable_store`, which needs a real host-owned `Memory`) by
    // seeding `STORE` with a `StableCell` over a throwaway `MemoryManager` -
    // no canister runtime needed, unlike `ic_cdk::api::is_controller` (see
    // `mask_secrets`, exercised separately via PocketIC in
    // `tests/config_endpoints.rs`).
    fn seed(initial: HashMap<String, ConfigValue>) {
        let mm =
            ic_stable_structures::memory_manager::MemoryManager::init(DefaultMemoryImpl::default());
        let memory = mm.get(ic_stable_structures::memory_manager::MemoryId::new(0));
        let cell = StableCell::init(memory, StorableConfig(initial));
        STORE.with(|s| *s.borrow_mut() = Some(cell));
    }

    #[test]
    fn mirror_replaces_the_map_and_get_env_variants_read_it_back() {
        let mut map = HashMap::new();
        map.insert(
            "env_test_text".to_string(),
            ConfigValue::Text("hi".to_string()),
        );
        map.insert("env_test_number".to_string(), ConfigValue::Number(7));
        map.insert("env_test_float".to_string(), ConfigValue::Float(1.5));
        map.insert("env_test_bool".to_string(), ConfigValue::Boolean(true));
        let principal = Principal::from_slice(&[9; 10]);
        map.insert(
            "env_test_principal".to_string(),
            ConfigValue::PrincipalId(principal),
        );
        mirror_env(&map);

        assert_eq!(get_env_text("env_test_text"), Some("hi".to_string()));
        assert_eq!(get_env_number("env_test_number"), Some(7));
        assert_eq!(get_env_float("env_test_float"), Some(1.5));
        assert_eq!(get_env_bool("env_test_bool"), Some(true));
        assert_eq!(get_env_principal("env_test_principal"), Some(principal));
        // Wrong-variant accessor returns None rather than panicking.
        assert_eq!(get_env_number("env_test_text"), None);
        assert_eq!(get_env_text("missing_key"), None);
    }

    #[test]
    fn set_rejects_unknown_keys() {
        seed(TestConfig::defaults());
        let mut update = HashMap::new();
        update.insert("nope".to_string(), ConfigValue::Text("x".to_string()));
        let err = set::<TestConfig>(update).unwrap_err();
        assert!(err.contains("unknown config key"), "{err}");
    }

    #[test]
    fn set_rejects_type_mismatch() {
        seed(TestConfig::defaults());
        let mut update = HashMap::new();
        update.insert(
            "retries".to_string(),
            ConfigValue::Text("three".to_string()),
        );
        let err = set::<TestConfig>(update).unwrap_err();
        assert!(err.contains("expects a Number value"), "{err}");
    }

    #[test]
    fn readonly_values_are_set_internally_but_rejected_by_public_set() {
        let mut initial = TestConfig::defaults();
        initial.insert("retries".to_string(), ConfigValue::Number(1));
        seed(initial);

        set_readonly::<TestConfig>("build_hash", ConfigValue::Text("abc123".to_string())).unwrap();
        assert_eq!(get_env_text("build_hash"), Some("abc123".to_string()));

        let error = set::<TestConfig>(HashMap::from([(
            "build_hash".to_string(),
            ConfigValue::Text("changed".to_string()),
        )]))
        .unwrap_err();
        assert!(error.contains("read-only"), "{error}");
        assert_eq!(get_env_text("build_hash"), Some("abc123".to_string()));
    }

    #[test]
    fn set_rejects_when_a_required_field_stays_missing() {
        // `retries` is required and has no default, so a fresh store (only
        // `greeting` seeded) must reject an update that doesn't supply it.
        seed(TestConfig::defaults());
        let mut update = HashMap::new();
        update.insert("greeting".to_string(), ConfigValue::Text("hi".to_string()));
        let err = set::<TestConfig>(update).unwrap_err();
        assert!(
            err.contains("missing required config key 'retries'"),
            "{err}"
        );
    }

    #[test]
    fn set_persists_and_mirrors_a_valid_update() {
        let mut initial = TestConfig::defaults();
        initial.insert("retries".to_string(), ConfigValue::Number(1));
        seed(initial);

        let mut update = HashMap::new();
        update.insert("retries".to_string(), ConfigValue::Number(5));
        set::<TestConfig>(update).unwrap();

        assert_eq!(get_raw().get("retries"), Some(&ConfigValue::Number(5)));
        // Unlisted keys (`greeting`) survive a partial update untouched.
        assert_eq!(
            get_raw().get("greeting"),
            Some(&ConfigValue::Text("hello".to_string()))
        );
        assert_eq!(get_env_number("retries"), Some(5));
    }

    #[test]
    fn unset_removes_an_optional_value_and_refreshes_the_env() {
        seed(HashMap::from([(
            "greeting".to_string(),
            ConfigValue::Text("hello".to_string()),
        )]));
        mirror_env(&get_raw());

        unset::<TestConfig>("greeting").unwrap();

        assert_eq!(get_raw().get("greeting"), None);
        assert_eq!(get_env_text("greeting"), None);
        assert!(unset::<TestConfig>("retries").is_err());
    }
}
