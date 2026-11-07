//! The agent's complete dashboard configuration surface. Every runtime
//! `Config` field is represented here, alongside the discovered business-
//! canister registry and read-only deployment information. Secret fields are
//! writable but deliberately omitted from `get_config` responses.

use candid::{CandidType, Principal};
use serde::Deserialize;
use std::cell::Cell;
use std::collections::HashMap;

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum ConfigType {
    Text,
    TextArea,
    Number,
    Float,
    Boolean,
    Select { options: Vec<String> },
    CanisterPicker { module_type_filter: Option<String> },
    SecretText,
    Vector { element_type: ConfigVectorType },
}

thread_local! {
    static CONFIG_UPDATE_PENDING: Cell<bool> = const { Cell::new(false) };
}

struct ConfigUpdateGuard;

impl ConfigUpdateGuard {
    fn acquire() -> Result<Self, String> {
        CONFIG_UPDATE_PENDING.with(|pending| {
            if pending.replace(true) {
                Err("another configuration update is already in progress".to_string())
            } else {
                Ok(Self)
            }
        })
    }
}

impl Drop for ConfigUpdateGuard {
    fn drop(&mut self) {
        CONFIG_UPDATE_PENDING.with(|pending| pending.set(false));
    }
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum ConfigVectorType {
    Text,
    Number,
    Float,
    Boolean,
    Select { options: Vec<String> },
    CanisterPicker { module_type_filter: Option<String> },
    SecretText,
}

#[derive(CandidType, Deserialize, Clone, Copy, Debug)]
pub enum CanisterType {
    Auth,
    Storage,
    Database,
    Custom,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum ConfigValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
    Vector(Vec<ConfigVectorValue>),
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum ConfigVectorValue {
    Text(String),
    Number(i64),
    Float(f64),
    Boolean(bool),
    PrincipalId(Principal),
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ConfigFieldSchema {
    pub key: String,
    pub label: String,
    pub description: String,
    pub group: Option<String>,
    pub group_label: Option<String>,
    pub group_description: Option<String>,
    pub field_type: ConfigType,
    pub canister_type: Option<CanisterType>,
    pub package_name: Option<String>,
    pub is_required: bool,
    pub is_readonly: Option<bool>,
    pub default_value: Option<ConfigValue>,
}

#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    Admin,
    Public,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CanisterLink {
    pub label: String,
    pub url: String,
    pub kind: LinkKind,
}

struct Endpoint {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    path: Option<&'static str>,
    group: &'static str,
    group_label: &'static str,
    group_description: &'static str,
}

const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        key: "whatsapp_webhook_url",
        label: "WhatsApp Webhook URL",
        description:
            "Use for both WhatsApp webhook verification (GET) and incoming messages (POST)",
        path: Some("/webhook/whatsapp"),
        group: "whatsapp",
        group_label: "WhatsApp",
        group_description: "Connect the agent to a WhatsApp Business account and use this URL when configuring Meta's webhook.",
    },
    Endpoint {
        key: "telegram_webhook_url",
        label: "Telegram Webhook URL",
        description: "Telegram sends bot updates to this HTTPS endpoint",
        path: Some("/webhook/telegram"),
        group: "telegram",
        group_label: "Telegram",
        group_description: "Connect a Telegram bot and configure Telegram to deliver updates to this endpoint.",
    },
    Endpoint {
        key: "admin_callback_webhook_url",
        label: "Admin Callback Webhook URL",
        description: "Administrative systems post signed action resolutions to this endpoint",
        path: Some("/webhook/admin"),
        group: "admin_escalation",
        group_label: "Administrative Escalation",
        group_description: "Configuration for handing sensitive or unsupported actions to the SME's administrative system.",
    },
    Endpoint {
        key: "email_ingress_method",
        label: "Email Ingress",
        description: "The configured mail bridge calls this Candid update method",
        path: None,
        group: "email",
        group_label: "Email",
        group_description: "Connect a mail bridge that forwards authenticated inbound email to the agent.",
    },
];

fn endpoint_value(endpoint: &Endpoint) -> String {
    match endpoint.path {
        Some(path) => format!("https://{}.icp0.io{path}", ic_cdk_020::api::canister_self()),
        None => "receive_mail (Candid update)".to_string(),
    }
}

fn editable_field(
    key: &str,
    label: &str,
    description: &str,
    group: &str,
    group_label: &str,
    group_description: &str,
    field_type: ConfigType,
    canister_type: Option<CanisterType>,
) -> ConfigFieldSchema {
    ConfigFieldSchema {
        key: key.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        group: Some(group.to_string()),
        group_label: Some(group_label.to_string()),
        group_description: Some(group_description.to_string()),
        field_type,
        canister_type,
        package_name: None,
        is_required: false,
        is_readonly: Some(false),
        default_value: None,
    }
}

const EDITABLE_CONFIG_KEYS: &[&str] = &[
    "connected_canisters",
    "project_id",
    "protocol_id",
    "mail_bridge_principal",
    "whatsapp_verify_token",
    "whatsapp_app_secret",
    "whatsapp_access_token",
    "whatsapp_phone_number_id",
    "telegram_secret_token",
    "telegram_bot_token",
    "mail_bridge_url",
    "mail_bridge_api_key",
    "mail_from_address",
    "system_prompt",
    "llm_provider",
    "llm_model",
    "llm_api_key",
    "max_output_tokens",
    "max_tool_iterations",
    "admin_webhook_url",
    "admin_webhook_secret",
];

#[ic_cdk_020::query]
fn get_config_schema() -> Vec<ConfigFieldSchema> {
    let mut fields = vec![
        editable_field(
            "connected_canisters",
            "Agentic Canisters",
            "Canisters whose llm_context is discovered and whose declared ai_* methods the agent may call",
            "project_integrations",
            "Project Integrations",
            "Shared project services and business canisters this agent can use.",
            ConfigType::Vector {
                element_type: ConfigVectorType::CanisterPicker {
                    module_type_filter: None,
                },
            },
            Some(CanisterType::Custom),
        ),
        editable_field(
            "project_id",
            "Project ID",
            "Project registry ID used to authorize protocol notification calls",
            "project_integrations",
            "Project Integrations",
            "Project identity and shared platform services used by this agent.",
            ConfigType::Text,
            None,
        ),
        editable_field(
            "protocol_id",
            "Protocol Canister",
            "CanisterHub protocol used for managed AI and project notifications",
            "project_integrations",
            "Project Integrations",
            "Project identity and shared platform services used by this agent.",
            ConfigType::CanisterPicker {
                module_type_filter: Some("protocol".to_string()),
            },
            Some(CanisterType::Custom),
        ),
        editable_field(
            "system_prompt",
            "System Prompt",
            "Instructions, persona, scope, and safety boundaries supplied to the model",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::TextArea,
            None,
        ),
        editable_field(
            "llm_provider",
            "AI Provider",
            "Choose Managed or a provider using your own API key",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::Select {
                options: vec![
                    "managed".to_string(),
                    "openai".to_string(),
                    "anthropic".to_string(),
                    "deepseek".to_string(),
                ],
            },
            None,
        ),
        editable_field(
            "llm_model",
            "Model",
            "DeepSeek, a free IC LLM model, or a standard model for a direct provider",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::Select {
                options: vec![
                    "deepseek-flash".to_string(),
                    "deepseek-v4-pro".to_string(),
                    // DeepSeek still accepts this legacy alias, though it
                    // now routes to the Flash model and bills at Flash rates.
                    "deepseek-v4-flash".to_string(),
                    "llama3.1:8b".to_string(),
                    "qwen3:32b".to_string(),
                    "llama4-scout".to_string(),
                    "qwen2.5:0.5b".to_string(),
                    "gpt-5.6-sol".to_string(),
                    "claude-sonnet-5".to_string(),
                ],
            },
            None,
        ),
        editable_field(
            "llm_api_key",
            "Provider API Key",
            "API key used only for direct OpenAI, Anthropic, or DeepSeek access",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "max_output_tokens",
            "Maximum Tokens per Message",
            "Maximum tokens generated by each assistant completion (defaults to 120)",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::Number,
            None,
        ),
        editable_field(
            "max_tool_iterations",
            "Maximum Tool Iterations",
            "Maximum model/tool round trips allowed for one message (0-255)",
            "ai",
            "AI",
            "Choose how the agent accesses an LLM and how it should behave.",
            ConfigType::Number,
            None,
        ),
        editable_field(
            "whatsapp_verify_token",
            "Verify Token",
            "Token Meta sends when verifying the WhatsApp webhook",
            "whatsapp",
            "WhatsApp",
            "Connect the agent to a WhatsApp Business account and use the webhook URL below when configuring Meta.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "whatsapp_app_secret",
            "App Secret",
            "Meta app secret used to authenticate webhook payloads",
            "whatsapp",
            "WhatsApp",
            "Connect the agent to a WhatsApp Business account and use the webhook URL below when configuring Meta.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "whatsapp_access_token",
            "Access Token",
            "Meta access token used to send WhatsApp replies",
            "whatsapp",
            "WhatsApp",
            "Connect the agent to a WhatsApp Business account and use the webhook URL below when configuring Meta.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "whatsapp_phone_number_id",
            "Phone Number ID",
            "WhatsApp Business phone number identifier",
            "whatsapp",
            "WhatsApp",
            "Connect the agent to a WhatsApp Business account and use the webhook URL below when configuring Meta.",
            ConfigType::Text,
            None,
        ),
        editable_field(
            "telegram_secret_token",
            "Webhook Secret Token",
            "Secret Telegram includes with webhook requests",
            "telegram",
            "Telegram",
            "Connect a Telegram bot and configure Telegram to deliver updates to the endpoint below.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "telegram_bot_token",
            "Bot Token",
            "Telegram bot token used to send replies",
            "telegram",
            "Telegram",
            "Connect a Telegram bot and configure Telegram to deliver updates to the endpoint below.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "mail_bridge_principal",
            "Mail Bridge Canister",
            "Only this canister principal may submit authenticated inbound mail",
            "email",
            "Email",
            "Connect a mail bridge that forwards authenticated inbound email to the agent.",
            ConfigType::CanisterPicker {
                module_type_filter: Some("mail_bridge".to_string()),
            },
            Some(CanisterType::Custom),
        ),
        editable_field(
            "mail_bridge_url",
            "Mail Bridge URL",
            "Base URL used to send email replies",
            "email",
            "Email",
            "Connect a mail bridge that forwards authenticated inbound email to the agent.",
            ConfigType::Text,
            None,
        ),
        editable_field(
            "mail_bridge_api_key",
            "Mail Bridge API Key",
            "Credential used when sending replies through the mail bridge",
            "email",
            "Email",
            "Connect a mail bridge that forwards authenticated inbound email to the agent.",
            ConfigType::SecretText,
            None,
        ),
        editable_field(
            "mail_from_address",
            "From Address",
            "Email address used for outgoing agent replies",
            "email",
            "Email",
            "Connect a mail bridge that forwards authenticated inbound email to the agent.",
            ConfigType::Text,
            None,
        ),
        editable_field(
            "admin_webhook_url",
            "Administrative Webhook URL",
            "Base URL that receives administrative escalation requests",
            "admin_escalation",
            "Administrative Escalation",
            "Configuration for handing sensitive or unsupported actions to the SME's administrative system.",
            ConfigType::Text,
            None,
        ),
        editable_field(
            "admin_webhook_secret",
            "Webhook Secret",
            "HMAC secret used to sign requests and verify administrative callbacks",
            "admin_escalation",
            "Administrative Escalation",
            "Configuration for handing sensitive or unsupported actions to the SME's administrative system.",
            ConfigType::SecretText,
            None,
        ),
        ConfigFieldSchema {
            key: "agent_canister_id".to_string(),
            label: "Agent Canister ID".to_string(),
            description: "Canister receiving every channel webhook".to_string(),
            group: Some("deployment".to_string()),
            group_label: Some("Deployment".to_string()),
            group_description: Some("Read-only identity and routing information for this agent canister.".to_string()),
            field_type: ConfigType::CanisterPicker {
                module_type_filter: Some("agent".to_string()),
            },
            canister_type: Some(CanisterType::Custom),
            package_name: None,
            is_required: false,
            is_readonly: Some(true),
            default_value: None,
        },
        ConfigFieldSchema {
            key: "inventory_canister_id".to_string(),
            label: "Inventory Canister ID".to_string(),
            description: "Project inventory package authorized to send customer order messages".to_string(),
            group: Some("deployment".to_string()),
            group_label: Some("Deployment".to_string()),
            group_description: Some("Read-only project package identities used by the agent.".to_string()),
            field_type: ConfigType::CanisterPicker { module_type_filter: None },
            canister_type: Some(CanisterType::Custom),
            package_name: Some("order_inventory.wasm".to_string()),
            is_required: false,
            is_readonly: Some(true),
            default_value: None,
        },
        ConfigFieldSchema {
            key: "restaurant_canister_id".to_string(),
            label: "Restaurant Canister ID".to_string(),
            description: "Project restaurant package authorized to send customer order receipts".to_string(),
            group: Some("deployment".to_string()),
            group_label: Some("Deployment".to_string()),
            group_description: Some("Read-only project package identities used by the agent.".to_string()),
            field_type: ConfigType::CanisterPicker { module_type_filter: None },
            canister_type: Some(CanisterType::Custom),
            package_name: Some("restaurant.wasm".to_string()),
            is_required: false,
            is_readonly: Some(true),
            default_value: None,
        },
    ];
    fields[0].default_value = Some(ConfigValue::Vector(vec![]));
    if let Some(field) = fields.iter_mut().find(|field| field.key == "protocol_id") {
        field.default_value = Some(ConfigValue::PrincipalId(
            crate::protocol::canister_id().expect("compiled protocol canister ID must be valid"),
        ));
    }
    if let Some(field) = fields.iter_mut().find(|field| field.key == "system_prompt") {
        field.default_value = Some(ConfigValue::Text(crate::llm::default_system_prompt()));
    }
    if let Some(field) = fields
        .iter_mut()
        .find(|field| field.key == "max_output_tokens")
    {
        field.default_value = Some(ConfigValue::Number(i64::from(
            crate::llm::DEFAULT_MAX_OUTPUT_TOKENS,
        )));
    }
    fields.extend(ENDPOINTS.iter().map(|endpoint| ConfigFieldSchema {
        key: endpoint.key.to_string(),
        label: endpoint.label.to_string(),
        description: endpoint.description.to_string(),
        group: Some(endpoint.group.to_string()),
        group_label: Some(endpoint.group_label.to_string()),
        group_description: Some(endpoint.group_description.to_string()),
        field_type: ConfigType::Text,
        canister_type: None,
        package_name: None,
        is_required: false,
        is_readonly: Some(true),
        default_value: None,
    }));
    fields
}

#[ic_cdk_020::query]
fn get_config() -> HashMap<String, ConfigValue> {
    let connected = crate::state::list_ai_canisters()
        .into_iter()
        .map(|canister| ConfigVectorValue::PrincipalId(canister.canister_id))
        .collect();
    let mut values = HashMap::from([
        (
            "connected_canisters".to_string(),
            ConfigValue::Vector(connected),
        ),
        (
            "agent_canister_id".to_string(),
            ConfigValue::PrincipalId(ic_cdk_020::api::canister_self()),
        ),
    ]);
    let config = crate::state::get_config();
    if let Some(inventory) = config.inventory_canister_id {
        values.insert(
            "inventory_canister_id".to_string(),
            ConfigValue::PrincipalId(inventory),
        );
    }
    if let Some(restaurant) = config.restaurant_canister_id {
        values.insert(
            "restaurant_canister_id".to_string(),
            ConfigValue::PrincipalId(restaurant),
        );
    }
    if let Some(value) = &config.project_id {
        values.insert("project_id".to_string(), ConfigValue::Text(value.clone()));
    }
    values.insert(
        "protocol_id".to_string(),
        ConfigValue::PrincipalId(config.protocol_id.unwrap_or_else(|| {
            crate::protocol::canister_id().expect("compiled protocol canister ID must be valid")
        })),
    );

    macro_rules! insert_text {
        ($key:literal, $field:ident) => {
            if let Some(value) = &config.$field {
                values.insert($key.to_string(), ConfigValue::Text(value.clone()));
            }
        };
    }
    macro_rules! insert_principal {
        ($key:literal, $field:ident) => {
            if let Some(value) = config.$field {
                values.insert($key.to_string(), ConfigValue::PrincipalId(value));
            }
        };
    }

    insert_principal!("mail_bridge_principal", mail_bridge_principal);
    insert_text!("whatsapp_phone_number_id", whatsapp_phone_number_id);
    insert_text!("mail_bridge_url", mail_bridge_url);
    insert_text!("mail_from_address", mail_from_address);
    values.insert(
        "system_prompt".to_string(),
        ConfigValue::Text(
            config
                .system_prompt
                .clone()
                .unwrap_or_else(crate::llm::default_system_prompt),
        ),
    );
    insert_text!("llm_provider", llm_provider);
    insert_text!("llm_model", llm_model);
    insert_text!("admin_webhook_url", admin_webhook_url);
    if let Some(value) = config.max_output_tokens {
        values.insert(
            "max_output_tokens".to_string(),
            ConfigValue::Number(i64::from(value)),
        );
    }
    if let Some(value) = config.max_tool_iterations {
        values.insert(
            "max_tool_iterations".to_string(),
            ConfigValue::Number(i64::from(value)),
        );
    }
    // SecretText fields intentionally remain absent. Their schema entries
    // make them writable without ever returning credential bytes to a query.
    values.extend(ENDPOINTS.iter().map(|endpoint| {
        (
            endpoint.key.to_string(),
            ConfigValue::Text(endpoint_value(endpoint)),
        )
    }));
    values
}

fn text_update(
    settings: &HashMap<String, ConfigValue>,
    key: &str,
) -> Result<Option<Option<String>>, String> {
    match settings.get(key) {
        None => Ok(None),
        Some(ConfigValue::Text(value)) if value.trim().is_empty() => Ok(Some(None)),
        Some(ConfigValue::Text(value)) => Ok(Some(Some(value.clone()))),
        Some(_) => Err(format!("config key '{key}' expects text")),
    }
}

fn principal_update(
    settings: &HashMap<String, ConfigValue>,
    key: &str,
) -> Result<Option<Option<Principal>>, String> {
    match settings.get(key) {
        None => Ok(None),
        Some(ConfigValue::PrincipalId(value)) => Ok(Some(Some(*value))),
        // The dynamic value model has no explicit Null variant. An empty
        // Text is therefore accepted as the clear operation for optional
        // canister pickers, while non-empty text remains a type error.
        Some(ConfigValue::Text(value)) if value.trim().is_empty() => Ok(Some(None)),
        Some(_) => Err(format!("config key '{key}' expects a canister ID")),
    }
}

fn apply_runtime_settings(
    mut config: crate::Config,
    settings: &HashMap<String, ConfigValue>,
) -> Result<(crate::Config, bool), String> {
    let mut changed = false;

    macro_rules! apply_text {
        ($key:literal, $field:ident) => {
            if let Some(value) = text_update(settings, $key)? {
                config.$field = value;
                changed = true;
            }
        };
    }
    macro_rules! apply_principal {
        ($key:literal, $field:ident) => {
            if let Some(value) = principal_update(settings, $key)? {
                config.$field = value;
                changed = true;
            }
        };
    }

    apply_principal!("mail_bridge_principal", mail_bridge_principal);
    apply_principal!("protocol_id", protocol_id);
    apply_text!("project_id", project_id);
    apply_text!("whatsapp_verify_token", whatsapp_verify_token);
    apply_text!("whatsapp_app_secret", whatsapp_app_secret);
    apply_text!("whatsapp_access_token", whatsapp_access_token);
    apply_text!("whatsapp_phone_number_id", whatsapp_phone_number_id);
    apply_text!("telegram_secret_token", telegram_secret_token);
    apply_text!("telegram_bot_token", telegram_bot_token);
    apply_text!("mail_bridge_url", mail_bridge_url);
    apply_text!("mail_bridge_api_key", mail_bridge_api_key);
    apply_text!("mail_from_address", mail_from_address);
    apply_text!("system_prompt", system_prompt);
    apply_text!("llm_provider", llm_provider);
    apply_text!("llm_model", llm_model);
    apply_text!("llm_api_key", llm_api_key);
    apply_text!("admin_webhook_url", admin_webhook_url);
    apply_text!("admin_webhook_secret", admin_webhook_secret);

    if let Some(value) = settings.get("max_output_tokens") {
        config.max_output_tokens = match value {
            ConfigValue::Number(value) => {
                let value = u32::try_from(*value).map_err(|_| {
                    "max_output_tokens must be between 1 and 4294967295".to_string()
                })?;
                if value == 0 {
                    return Err("max_output_tokens must be between 1 and 4294967295".to_string());
                }
                Some(value)
            }
            ConfigValue::Text(value) if value.trim().is_empty() => None,
            _ => return Err("config key 'max_output_tokens' expects a number".to_string()),
        };
        changed = true;
    }

    if let Some(value) = settings.get("max_tool_iterations") {
        config.max_tool_iterations = match value {
            ConfigValue::Number(value) => Some(
                u8::try_from(*value)
                    .map_err(|_| "max_tool_iterations must be between 0 and 255".to_string())?,
            ),
            ConfigValue::Text(value) if value.trim().is_empty() => None,
            _ => return Err("config key 'max_tool_iterations' expects a number".to_string()),
        };
        changed = true;
    }

    Ok((config, changed))
}

/// Applies install-time project context before the first config is persisted.
/// Explicit init config wins; only empty values are filled. Canister fields
/// resolve through schema `package_name` metadata and never through project
/// canister labels.
pub(crate) fn prefill_from_project_context(
    config: crate::Config,
    context: Option<&crate::ProjectContext>,
) -> crate::Config {
    let Some(context) = context else {
        return config;
    };
    prefill_from_schema(config, context, get_config_schema())
}

fn prefill_from_schema(
    mut config: crate::Config,
    context: &crate::ProjectContext,
    schema: Vec<ConfigFieldSchema>,
) -> crate::Config {
    if config.project_id.is_none() && !context.project_id.trim().is_empty() {
        config.project_id = Some(context.project_id.clone());
    }

    for field in schema {
        let Some(package_name) = field.package_name.as_deref() else {
            continue;
        };
        let Some(canister_id) = context.canister_for_package(package_name) else {
            continue;
        };
        match field.key.as_str() {
            "protocol_id" if config.protocol_id.is_none() => config.protocol_id = Some(canister_id),
            "inventory_canister_id" => config.inventory_canister_id = Some(canister_id),
            "restaurant_canister_id" => config.restaurant_canister_id = Some(canister_id),
            "mail_bridge_principal" if config.mail_bridge_principal.is_none() => {
                config.mail_bridge_principal = Some(canister_id)
            }
            _ => {}
        }
    }
    config
}

#[ic_cdk_020::update]
async fn set_config(new_settings: HashMap<String, ConfigValue>) -> Result<(), String> {
    if !ic_cdk_020::api::is_controller(&ic_cdk_020::api::msg_caller()) {
        return Err("only a controller may change configuration".to_string());
    }
    let _guard = ConfigUpdateGuard::acquire()?;
    let mut changed_keys = new_settings.keys().cloned().collect::<Vec<_>>();
    changed_keys.sort();
    crate::log_info(format!(
        "dynamic configuration update started keys={}",
        changed_keys.join(",")
    ));

    for key in new_settings.keys() {
        if !EDITABLE_CONFIG_KEYS.contains(&key.as_str()) {
            let read_only = get_config_schema()
                .into_iter()
                .any(|field| field.key == *key && field.is_readonly == Some(true));
            return Err(if read_only {
                format!("config key '{key}' is read-only")
            } else {
                format!("unknown config key '{key}'")
            });
        }
    }

    let (_, runtime_changed) = apply_runtime_settings(crate::state::get_config(), &new_settings)?;

    let desired = match new_settings.get("connected_canisters") {
        None => None,
        Some(ConfigValue::Vector(entries)) => {
            let mut desired = Vec::with_capacity(entries.len());
            for entry in entries {
                let ConfigVectorValue::PrincipalId(canister_id) = entry else {
                    return Err("connected_canisters entries must be canister IDs".to_string());
                };
                if desired.contains(canister_id) {
                    return Err(format!("duplicate connected canister '{canister_id}'"));
                }
                desired.push(*canister_id);
            }
            Some(desired)
        }
        Some(_) => {
            return Err("config key 'connected_canisters' expects a Vector value".to_string())
        }
    };

    if let Some(desired) = desired {
        let current = crate::state::list_ai_canisters();
        let mut additions = Vec::new();
        for canister_id in desired
            .iter()
            .copied()
            .filter(|id| !current.iter().any(|existing| existing.canister_id == *id))
        {
            additions.push(crate::remote_tools::discover(canister_id).await?);
        }

        for existing in current {
            if !desired.contains(&existing.canister_id) {
                crate::state::remove_ai_canister(existing.canister_id);
            }
        }
        for discovered in additions {
            crate::state::set_ai_canister(discovered);
        }
    }

    if runtime_changed {
        // Re-read after discovery's awaits so a legacy `update_config` call
        // that interleaved does not have unrelated fields overwritten by a
        // stale pre-await snapshot.
        let (config, _) = apply_runtime_settings(crate::state::get_config(), &new_settings)?;
        crate::state::set_config(config);
        crate::assets::certify();
    }
    crate::log_info(format!(
        "dynamic configuration update completed runtime_changed={runtime_changed}"
    ));
    Ok(())
}

#[ic_cdk_020::query]
fn get_links() -> Vec<CanisterLink> {
    vec![
        CanisterLink {
            label: "SME Inbox".to_string(),
            url: "/inbox".to_string(),
            kind: LinkKind::Admin,
        },
        CanisterLink {
            label: "Customer Chat".to_string(),
            url: "/chat".to_string(),
            kind: LinkKind::Public,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_runtime_setting_is_in_the_dynamic_schema() {
        let schema = get_config_schema();
        assert_eq!(schema.len(), 26);
        let mut editable: Vec<_> = schema
            .iter()
            .filter(|field| field.is_readonly == Some(false))
            .map(|field| field.key.as_str())
            .collect();
        let mut expected = EDITABLE_CONFIG_KEYS.to_vec();
        editable.sort_unstable();
        expected.sort_unstable();
        assert_eq!(editable, expected);

        let connected = schema
            .iter()
            .find(|field| field.key == "connected_canisters")
            .unwrap();
        assert!(matches!(
            connected.field_type,
            ConfigType::Vector {
                element_type: ConfigVectorType::CanisterPicker { .. }
            }
        ));
        assert!(matches!(
            schema
                .iter()
                .find(|field| field.key == "llm_api_key")
                .unwrap()
                .field_type,
            ConfigType::SecretText
        ));
        assert!(matches!(
            schema
                .iter()
                .find(|field| field.key == "system_prompt")
                .unwrap()
                .field_type,
            ConfigType::TextArea
        ));
        assert!(matches!(
            schema
                .iter()
                .find(|field| field.key == "system_prompt")
                .unwrap()
                .default_value
                .as_ref(),
            Some(ConfigValue::Text(value)) if value == &crate::llm::default_system_prompt()
        ));

        let provider_index = schema
            .iter()
            .position(|field| field.key == "llm_provider")
            .unwrap();
        let model_index = schema
            .iter()
            .position(|field| field.key == "llm_model")
            .unwrap();
        assert_eq!(model_index, provider_index + 1);

        let ConfigType::Select { options: providers } = &schema[provider_index].field_type else {
            panic!("llm_provider must be a select");
        };
        assert_eq!(providers.first().map(String::as_str), Some("managed"));
        assert!(!providers
            .iter()
            .any(|provider| provider == "managed_deepseek"));
        assert!(!providers
            .iter()
            .any(|provider| provider == "managed_ic_llm"));

        let ConfigType::Select { options: models } = &schema[model_index].field_type else {
            panic!("llm_model must be a select");
        };
        for expected in [
            "deepseek-flash",
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "llama3.1:8b",
            "qwen3:32b",
            "llama4-scout",
            "qwen2.5:0.5b",
        ] {
            assert!(models.iter().any(|model| model == expected));
        }
    }

    #[test]
    fn project_context_prefills_a_canister_field_by_package_name() {
        let dependency = Principal::from_slice(&[9; 10]);
        let context = crate::ProjectContext {
            project_id: "project-9".to_string(),
            canisters: vec![crate::ProjectCanister {
                canister_id: dependency,
                package_name: "mail_bridge.wasm".to_string(),
            }],
        };
        let mut field = editable_field(
            "mail_bridge_principal",
            "Mail Bridge",
            "",
            "email",
            "Email",
            "",
            ConfigType::CanisterPicker {
                module_type_filter: None,
            },
            Some(CanisterType::Custom),
        );
        field.package_name = Some("mail_bridge.wasm".to_string());

        let config = prefill_from_schema(crate::Config::default(), &context, vec![field]);
        assert_eq!(config.project_id.as_deref(), Some("project-9"));
        assert_eq!(config.mail_bridge_principal, Some(dependency));
    }

    #[test]
    fn runtime_settings_accept_dynamic_values_and_empty_text_clears_them() {
        let settings = HashMap::from([
            (
                "llm_api_key".to_string(),
                ConfigValue::Text("secret".to_string()),
            ),
            ("max_tool_iterations".to_string(), ConfigValue::Number(12)),
        ]);
        let (configured, changed) =
            apply_runtime_settings(crate::Config::default(), &settings).unwrap();
        assert!(changed);
        assert_eq!(configured.llm_api_key.as_deref(), Some("secret"));
        assert_eq!(configured.max_tool_iterations, Some(12));

        let clear = HashMap::from([
            ("llm_api_key".to_string(), ConfigValue::Text(String::new())),
            (
                "max_tool_iterations".to_string(),
                ConfigValue::Text(String::new()),
            ),
        ]);
        let (cleared, _) = apply_runtime_settings(configured, &clear).unwrap();
        assert_eq!(cleared.llm_api_key, None);
        assert_eq!(cleared.max_tool_iterations, None);
    }

    #[test]
    fn links_enumerate_the_inbox_and_customer_chat() {
        assert_eq!(
            get_links(),
            vec![
                CanisterLink {
                    label: "SME Inbox".to_string(),
                    url: "/inbox".to_string(),
                    kind: LinkKind::Admin,
                },
                CanisterLink {
                    label: "Customer Chat".to_string(),
                    url: "/chat".to_string(),
                    kind: LinkKind::Public,
                },
            ]
        );
    }
}
