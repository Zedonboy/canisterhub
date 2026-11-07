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
//!     #[config(label = "Allowed origins")]
//!     pub allowed_origins: Vec<String>,
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
//! - `#[config_links(("Admin", "/admin", Admin), ("Home", "/", Public))]`
//!   declares the webpages returned by `get_links` - see "Endpoint
//!   semantics" below.
//!
//! ## Field attributes
//!
//! All `#[config(...)]` items are optional.
//!
//! - `label = "..."` (defaults to the field name in Title Case, e.g. `retry_count` -> `"Retry Count"`)
//! - `description = "..."` (defaults to `""`)
//! - `key = "..."` (defaults to the field name)
//! - `group = "..."` places related fields in one foldable settings section.
//!   `group_label = "..."` and `group_description = "..."` customize that
//!   section's heading and helper text. Fields with the same group key are
//!   collected together; metadata only needs to be declared on one of them.
//! - `default = <literal>` (marks the field optional; literal type must match the field)
//! - `multiline` (`String`/`Option<String>` only -> `ConfigType::TextArea`)
//! - `secret` (`String`/`Option<String>` only -> `ConfigType::SecretText`,
//!   **write-only**: `get_config` returns [`MASKED_SECRET`] for it no
//!   matter who asks - see the "Secret egress" note in "Endpoint
//!   semantics" below)
//! - `readonly` (shown to settings clients but rejected by `set_config`;
//!   canister code populates it with [`set_readonly`]). Combine it with
//!   `secret` when the value itself is sensitive.
//! - `select(options = ["a", "b"])` (`String`/`Option<String>` only -> `ConfigType::Select`; a `default` must be one of `options`)
//! - `canister_picker` or `canister_picker(module_type = "...")` (`Principal`/`Option<Principal>` only -> `ConfigType::CanisterPicker`)
//! - `canister_type = "auth" | "storage" | "database" | "custom"`
//! - `package_name = "<artifact>.wasm"` associates a Principal picker
//!   with an installable package so project context can prefill it
//!   (`Principal`, `Vec<Principal>`, or optional forms). This is typed
//!   metadata for a canister picker. If omitted, consumers must treat it as
//!   `custom`.
//!
//! Supported field types: `String`, `i64` (-> `Number`), `f64` (-> `Float`),
//! `bool` (-> `Boolean`), `candid::Principal` (-> `CanisterPicker`), and a
//! homogeneous `Vec<T>` of any of those. Vector fields start with an empty
//! default and settings clients can add or remove individual entries.
//! `Option<T>` makes the field optional
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
//! - `get_config` **masks `SecretText` fields** (`"••••••••"`) for every
//!   caller, controllers included. Secrets are write-only: a controller
//!   principal is exactly what a settings UI or an embedded module page
//!   acts as, so letting controllers read the plaintext back would hand it
//!   to any browser session (and, through the dashboard's module
//!   delegation, to any embedded third-party page) - the "secret egress"
//!   problem. Presence of the key still tells a settings client the secret
//!   is set; changing it is a `set_config` write. Internal code always
//!   sees the real value via the env mirror, which isn't caller-scoped.
//! - `get_links` is a public query returning the webpages declared by
//!   `#[config_links((label, url, kind), ...)]`, in declaration order. The
//!   kind is [`LinkKind::Admin`] for an owner-only embedded page or
//!   [`LinkKind::Public`] for a public-facing page. With no declarations it
//!   returns an empty vector. A URL may contain `{canister_id}`, substituted
//!   at call time with this canister's own principal (see
//!   [`resolve_url_template`]).
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
    /// Same stored value as `Text`, presented by settings clients as a
    /// multiline text area.
    TextArea,
    Number,
    Float,
    Boolean,
    Select {
        options: Vec<String>,
    },
    CanisterPicker {
        module_type_filter: Option<String>,
    },
    /// Same wire shape as `Text`; `get_config` masks the value for every
    /// caller (see this module's doc comment - secrets are write-only).
    SecretText,
    /// A repeatable setting whose entries all share one scalar type. The
    /// settings UI renders this as a list with per-entry Add/Remove controls.
    Vector {
        element_type: ConfigVectorType,
    },
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum ConfigVectorType {
    Text,
    Number,
    Float,
    Boolean,
    Select { options: Vec<String> },
    CanisterPicker { module_type_filter: Option<String> },
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
    Vector(Vec<ConfigVectorValue>),
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum ConfigVectorValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
}

impl ConfigVectorValue {
    fn matches(&self, element_type: &ConfigVectorType) -> bool {
        match (element_type, self) {
            (ConfigVectorType::Text, ConfigVectorValue::Text(_)) => true,
            (ConfigVectorType::SecretText, ConfigVectorValue::Text(_)) => true,
            (ConfigVectorType::Number, ConfigVectorValue::Number(_)) => true,
            (ConfigVectorType::Float, ConfigVectorValue::Float(_)) => true,
            (ConfigVectorType::Boolean, ConfigVectorValue::Boolean(_)) => true,
            (ConfigVectorType::CanisterPicker { .. }, ConfigVectorValue::PrincipalId(_)) => true,
            (ConfigVectorType::Select { options }, ConfigVectorValue::Text(value)) => {
                options.iter().any(|option| option == value)
            }
            _ => false,
        }
    }
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
            ConfigValue::Vector(_) => "Vector",
        }
    }

    /// Whether this value is an acceptable instance of `field_type` (for
    /// `Select`, also checks membership in `options`).
    pub fn matches(&self, field_type: &ConfigType) -> bool {
        match (field_type, self) {
            (ConfigType::Text, ConfigValue::Text(_)) => true,
            (ConfigType::TextArea, ConfigValue::Text(_)) => true,
            (ConfigType::SecretText, ConfigValue::Text(_)) => true,
            (ConfigType::Number, ConfigValue::Number(_)) => true,
            (ConfigType::Float, ConfigValue::Float(_)) => true,
            (ConfigType::Boolean, ConfigValue::Boolean(_)) => true,
            (ConfigType::CanisterPicker { .. }, ConfigValue::PrincipalId(_)) => true,
            (ConfigType::Select { options }, ConfigValue::Text(value)) => {
                options.iter().any(|option| option == value)
            }
            (ConfigType::Vector { element_type }, ConfigValue::Vector(values)) => {
                values.iter().all(|value| value.matches(element_type))
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
    /// Optional presentation metadata. These are optional on the wire so a
    /// new dashboard can still decode schemas from older module canisters.
    pub group: Option<String>,
    pub group_label: Option<String>,
    pub group_description: Option<String>,
    pub field_type: ConfigType,
    /// Optional typed filter for canister-picker fields. `None` has the
    /// same meaning as `Some(CanisterType::Custom)`.
    pub canister_type: Option<CanisterType>,
    /// Optional `.wasm` artifact name for a canister dependency. Package
    /// installers can use this to prefill the picker from the project's
    /// already-installed canisters without matching project canister labels.
    pub package_name: Option<String>,
    pub is_required: bool,
    /// `Some(true)` means this value is canister-provided display data and
    /// cannot be changed through `set_config`. Optional on the wire so new
    /// settings clients remain compatible with older module canisters.
    pub is_readonly: Option<bool>,
    pub default_value: Option<ConfigValue>,
}

/// How a dashboard should present one webpage exposed by a module.
#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// An authenticated internal page suitable for the dashboard iframe.
    Admin,
    /// A public-facing page opened as an ordinary external link.
    Public,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CanisterLink {
    pub label: String,
    pub url: String,
    pub kind: LinkKind,
}

impl ConfigFieldSchema {
    /// Returns the effective picker type. An omitted type deliberately
    /// resolves to `Custom`; non-picker fields have no canister type.
    pub fn resolved_canister_type(&self) -> Option<CanisterType> {
        matches!(
            self.field_type,
            ConfigType::CanisterPicker { .. }
                | ConfigType::Vector {
                    element_type: ConfigVectorType::CanisterPicker { .. }
                }
        )
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
    /// Webpages declared by `#[config_links(...)]`, in declaration order.
    fn links() -> Vec<CanisterLink>;
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
    static CHANGE_HOOK: RefCell<Option<fn()>> = const { RefCell::new(None) };
}

// Stored alongside config in the existing stable cell so upgrades do not
// need to reserve another stable-memory segment. Never expose this key to
// settings clients or the env mirror.
const USER_CONFIGURED_KEY: &str = "__canister_hub_user_configured_keys";

fn user_configured(map: &HashMap<String, ConfigValue>) -> Vec<String> {
    match map.get(USER_CONFIGURED_KEY) {
        Some(ConfigValue::Vector(values)) => values.iter().filter_map(|value| match value {
            ConfigVectorValue::Text(key) => Some(key.clone()),
            _ => None,
        }).collect(),
        _ => Vec::new(),
    }
}

fn record_user_configured(map: &mut HashMap<String, ConfigValue>, keys: impl IntoIterator<Item = String>) {
    let mut configured = user_configured(map);
    for key in keys {
        if !configured.contains(&key) { configured.push(key); }
    }
    map.insert(USER_CONFIGURED_KEY.to_string(), ConfigValue::Vector(
        configured.into_iter().map(ConfigVectorValue::Text).collect(),
    ));
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
    // Older versions did not persist edit provenance. Preserve any existing
    // package-linked values as user-owned rather than risk overwriting a
    // setting someone edited before upgrading.
    if !merged.contains_key(USER_CONFIGURED_KEY) {
        let existing_package_fields: Vec<String> = T::schema().into_iter()
            .filter(|field| field.package_name.is_some() && merged.contains_key(&field.key))
            .map(|field| field.key).collect();
        if !existing_package_fields.is_empty() {
            record_user_configured(&mut merged, existing_package_fields);
        }
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
    ENV.with(|e| *e.borrow_mut() = map.iter().filter(|(key, _)| key.as_str() != USER_CONFIGURED_KEY)
        .map(|(key, value)| (key.clone(), value.clone())).collect());
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
    CHANGE_HOOK.with(|hook| {
        if let Some(callback) = *hook.borrow() {
            callback();
        }
    });
}

/// Registers a heap-only callback invoked after a dynamic configuration
/// mutation has been persisted and mirrored into the runtime environment.
/// Register it again during `post_upgrade`.
pub fn set_change_hook(callback: fn()) {
    CHANGE_HOOK.with(|hook| *hook.borrow_mut() = Some(callback));
}

/// What `get_config` substitutes for a stored `SecretText` value. Secrets
/// are write-only: this exact literal is what every caller - controller or
/// not - sees, so settings UIs can distinguish "set" (key present, masked)
/// from "unset" (key absent) without ever receiving the real value.
pub const MASKED_SECRET: &str = "••••••••";

/// Masks every `SecretText` field's value. This deliberately applies to
/// controllers too: controller principals are exactly the identities a
/// settings UI or an embedded module page acts as, and the plaintext must
/// never cross the candid boundary into a browser (see this module's doc
/// comment - "secret egress"). Internal code still reads the real value
/// through the env mirror, which is canister code, not a caller-scoped
/// endpoint.
fn mask_secrets<T: ConfigSchema>(
    mut map: HashMap<String, ConfigValue>,
) -> HashMap<String, ConfigValue> {
    for field in T::schema() {
        if matches!(field.field_type, ConfigType::SecretText) && map.contains_key(&field.key) {
            map.insert(field.key, ConfigValue::Text(MASKED_SECRET.to_string()));
        } else if matches!(
            field.field_type,
            ConfigType::Vector {
                element_type: ConfigVectorType::SecretText
            }
        ) && map.contains_key(&field.key)
        {
            let count = match map.get(&field.key) {
                Some(ConfigValue::Vector(values)) => values.len(),
                _ => 0,
            };
            map.insert(
                field.key,
                ConfigValue::Vector(vec![ConfigVectorValue::Text(MASKED_SECRET.to_string()); count]),
            );
        }
    }
    map
}

/// Backs the generated `get_config` query.
pub fn get<T: ConfigSchema>() -> HashMap<String, ConfigValue> {
    let mut map = get_raw();
    map.remove(USER_CONFIGURED_KEY);
    mask_secrets::<T>(map)
}

/// The settings surface reads secrets back as [`MASKED_SECRET`]; a client
/// that round-trips that placeholder into `set_config` would overwrite the
/// real value with the mask, so `set` rejects it outright.
fn contains_mask_placeholder(value: &ConfigValue) -> bool {
    match value {
        ConfigValue::Text(text) => text == MASKED_SECRET,
        ConfigValue::Vector(values) => values.iter().any(|value| {
            matches!(value, ConfigVectorValue::Text(text) if text == MASKED_SECRET)
        }),
        _ => false,
    }
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
        // Settings surfaces read secrets back as `MASKED_SECRET`; a client
        // that round-trips that placeholder into `set_config` must never
        // overwrite the real value with it.
        if contains_mask_placeholder(value) {
            return Err(format!(
                "config key '{key}' received the masked placeholder - \
                 leave a secret unchanged by omitting it from the update"
            ));
        }
        merged.insert(key.clone(), value.clone());
    }

    for field in &schema {
        if field.is_required && !merged.contains_key(&field.key) {
            return Err(format!("missing required config key '{}'", field.key));
        }
    }

    record_user_configured(&mut merged, new_settings.keys().cloned());
    persist(merged);
    Ok(())
}

/// Writes canister-owned defaults without marking the value as user-edited.
pub fn set_system<T: ConfigSchema>(new_settings: HashMap<String, ConfigValue>) -> Result<(), String> {
    let schema: HashMap<String, ConfigFieldSchema> = T::schema().into_iter().map(|field| (field.key.clone(), field)).collect();
    let mut config = get_raw();
    for (key, value) in new_settings {
        let field = schema.get(&key).ok_or_else(|| format!("unknown config key '{key}'"))?;
        if !value.matches(&field.field_type) {
            return Err(format!("config key '{key}' expects a {:?} value, got a {} value", field.field_type, value.type_name()));
        }
        if !user_configured(&config).contains(&key) { config.insert(key, value); }
    }
    persist(config);
    Ok(())
}

/// Applies package-derived canister picker defaults from the latest project
/// context. Fields explicitly written through `set_config` are preserved.
pub fn update_project_context<T: ConfigSchema>(context: &crate::ProjectContext) -> Result<(), String> {
    let mut config = get_raw();
    let configured = user_configured(&config);
    let mut updates = HashMap::new();
    let mut removals = Vec::new();
    for field in T::schema() {
        let Some(package_name) = field.package_name.as_deref() else { continue };
        if configured.contains(&field.key) { continue; }
        let matches: Vec<Principal> = context.canisters.iter()
            .filter(|canister| canister.package_name.trim().eq_ignore_ascii_case(package_name.trim()))
            .map(|canister| canister.canister_id).collect();
        let value = match field.field_type {
            ConfigType::CanisterPicker { .. } => matches.first().copied().map(ConfigValue::PrincipalId),
            ConfigType::Vector { element_type: ConfigVectorType::CanisterPicker { .. } } =>
                Some(ConfigValue::Vector(matches.into_iter().map(ConfigVectorValue::PrincipalId).collect())),
            _ => None,
        };
        if let Some(value) = value { updates.insert(field.key, value); }
        else if !field.is_required { removals.push(field.key); }
    }
    if !context.project_id.trim().is_empty() {
        let project_field = T::schema().into_iter().find(|field| field.key == "project_id");
        if let Some(field) = project_field.filter(|field| !configured.contains(&field.key)) {
            if matches!(field.field_type, ConfigType::Text | ConfigType::TextArea) {
                updates.insert(field.key, ConfigValue::Text(context.project_id.clone()));
            }
        }
    }
    for (key, value) in updates {
        config.insert(key, value);
    }
    for key in removals { config.remove(&key); }
    persist(config);
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
    record_user_configured(&mut config, [key.to_string()]);
    persist(config);
    Ok(())
}

/// Substitutes the placeholder `{canister_id}` in `template` with this
/// canister's own principal (text form). Used by the generated `get_links`
/// when a link URL contains the placeholder.
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

pub fn get_env_vector(key: &str) -> Option<Vec<ConfigVectorValue>> {
    match get_env(key) {
        Some(ConfigValue::Vector(value)) => Some(value),
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
            group: None,
            group_label: None,
            group_description: None,
            field_type: ConfigType::CanisterPicker {
                module_type_filter: None,
            },
            canister_type: None,
            package_name: None,
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
                    group: None,
                    group_label: None,
                    group_description: None,
                    field_type: ConfigType::Text,
                    canister_type: None,
                    package_name: None,
                    is_required: false,
                    is_readonly: None,
                    default_value: Some(ConfigValue::Text("hello".to_string())),
                },
                ConfigFieldSchema {
                    key: "retries".to_string(),
                    label: "Retries".to_string(),
                    description: String::new(),
                    group: None,
                    group_label: None,
                    group_description: None,
                    field_type: ConfigType::Number,
                    canister_type: None,
                    package_name: None,
                    is_required: true,
                    is_readonly: None,
                    default_value: None,
                },
                ConfigFieldSchema {
                    key: "api_key".to_string(),
                    label: "API Key".to_string(),
                    description: String::new(),
                    group: None,
                    group_label: None,
                    group_description: None,
                    field_type: ConfigType::SecretText,
                    canister_type: None,
                    package_name: None,
                    is_required: false,
                    is_readonly: None,
                    default_value: None,
                },
                ConfigFieldSchema {
                    key: "build_hash".to_string(),
                    label: "Build Hash".to_string(),
                    description: String::new(),
                    group: None,
                    group_label: None,
                    group_description: None,
                    field_type: ConfigType::Text,
                    canister_type: None,
                    package_name: None,
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

        fn links() -> Vec<CanisterLink> {
            Vec::new()
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
    fn set_rejects_the_mask_placeholder_so_a_secret_is_never_overwritten_with_it() {
        let mut initial = TestConfig::defaults();
        initial.insert("retries".to_string(), ConfigValue::Number(1));
        initial.insert(
            "api_key".to_string(),
            ConfigValue::Text("sk-live-real".to_string()),
        );
        seed(initial);

        let err = set::<TestConfig>(HashMap::from([(
            "api_key".to_string(),
            ConfigValue::Text(MASKED_SECRET.to_string()),
        )]))
        .unwrap_err();
        assert!(err.contains("masked placeholder"), "{err}");
        // The stored secret survives untouched.
        assert_eq!(
            get_raw().get("api_key"),
            Some(&ConfigValue::Text("sk-live-real".to_string()))
        );
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
