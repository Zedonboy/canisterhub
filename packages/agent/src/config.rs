//! Typed storage for every runtime parameter this canister needs. The primary
//! management surface is the grouped dynamic configuration API in
//! `dynamic_config.rs`; the optional init record and `ConfigUpdate` remain as
//! compatibility paths for existing deployments and callers.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// Project-owned canisters available when this package is installed. The
/// package name is the stable `.wasm` filename, not a project canister label.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectCanister {
    pub canister_id: Principal,
    pub package_name: String,
}

/// The single standard install argument supplied to every package.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ProjectContext {
    pub project_id: String,
    pub canisters: Vec<ProjectCanister>,
}

impl ProjectContext {
    pub fn canister_for_package(&self, package_name: &str) -> Option<Principal> {
        let package_name = package_name.trim();
        self.canisters
            .iter()
            .find(|canister| {
                canister
                    .package_name
                    .trim()
                    .eq_ignore_ascii_case(package_name)
            })
            .map(|canister| canister.canister_id)
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    /// Project registry key used when this package calls protocol APIs.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Optional override for the compiled CanisterHub protocol principal.
    /// Dynamic config exposes the compiled principal as this field's default.
    #[serde(default)]
    pub protocol_id: Option<Principal>,
    /// Project inventory package allowed to send customer-facing business
    /// messages (for example, verified payment receipts).
    #[serde(default)]
    pub inventory_canister_id: Option<Principal>,
    /// Restaurant package allowed to send customer-facing order receipts.
    #[serde(default)]
    pub restaurant_canister_id: Option<Principal>,
    pub mail_bridge_principal: Option<Principal>,
    pub whatsapp_verify_token: Option<String>,
    pub whatsapp_app_secret: Option<String>,
    pub whatsapp_access_token: Option<String>,
    pub whatsapp_phone_number_id: Option<String>,
    pub telegram_secret_token: Option<String>,
    pub telegram_bot_token: Option<String>,
    pub mail_bridge_url: Option<String>,
    pub mail_bridge_api_key: Option<String>,
    pub mail_from_address: Option<String>,

    /// The system prompt prepended to every conversation - this is the main
    /// thing a business customizes: persona, tone, what the assistant is
    /// for, an explicit statement of what it *can't* do, and its reply
    /// formatting (the chat renders Markdown - see `llm::default_system_prompt`
    /// for the fallback's shape, including the image-URL-on-its-own-line
    /// convention for showing product photos). If unset, a generic fallback
    /// is used.
    pub system_prompt: Option<String>,
    /// `managed` routes through CanisterHub's backend and selects IC LLM or
    /// DeepSeek from `llm_model`. `openai`, `anthropic`, and `deepseek` call
    /// the provider directly with the SME's own `llm_api_key`. Legacy
    /// `managed_ic_llm`, `managed_deepseek`, `platform`, and `gemini` values
    /// remain accepted.
    pub llm_provider: Option<String>,
    /// Provider-specific model id (e.g. `"gpt-5.6-sol"`, `"claude-sonnet-5"`,
    /// `"gemini-3.1-pro-preview"`, `"deepseek-v4-pro"`, or - for `"managed"` -
    /// `"llama3.1:8b"`/`"qwen3:32b"`/`"llama4-scout"`/`"qwen2.5:0.5b"`
    /// (free) / `"gemma3:27b"`/`"z-ai:glm-5.2"` (paid, drawn from this
    /// canister's own cycles balance)) - defaults to that provider's
    /// flagship model if unset (see `llm::default_model_for`).
    pub llm_model: Option<String>,
    /// API key for a direct/BYOK provider. Never sent to CanisterHub's
    /// backend and ignored for managed providers.
    pub llm_api_key: Option<String>,
    /// Maximum number of tokens the model may generate for each completion
    /// in a message's agent loop. Unset uses the assistant-oriented default
    /// of 120 tokens.
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    /// Upper bound on how many LLM <-> tool round trips one incoming
    /// message may cause before this canister gives up and escalates to a
    /// human (see `llm::run_agent_loop`) - bounds cycle spend and stable
    /// storage growth from a model that won't stop calling tools. Defaults
    /// to `DEFAULT_MAX_TOOL_ITERATIONS` if unset.
    pub max_tool_iterations: Option<u8>,

    /// Base URL an administrative system's callback listens on -
    /// `request_admin_action`-triggered requests are POSTed to
    /// `<this>/admin/requests` (see `admin.rs`). Unset = administrative
    /// escalation is disabled entirely: `request_admin_action` returns an
    /// error to the model instead of silently doing nothing.
    pub admin_webhook_url: Option<String>,
    /// Shared HMAC-SHA256 key used both directions: signing this
    /// canister's outbound request to `admin_webhook_url` (so the receiving
    /// system can verify it really came from here), and verifying the
    /// inbound callback to `POST /webhook/admin` (so this canister only
    /// acts on callbacks the operator's own system sent). Using one key
    /// both ways is the simplest correct setup for a template; splitting it
    /// into two independent keys is a straightforward hardening step for a
    /// production deployment - see README.md's "Hardening ideas".
    pub admin_webhook_secret: Option<String>,
}

/// `update_config`'s argument - see `Config`'s doc comment. Semantics
/// (three states per field) are identical to `connector`'s `ConfigUpdate`;
/// see that type's doc comment for the full explanation.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub project_id: Option<Option<String>>,
    pub protocol_id: Option<Option<Principal>>,
    pub mail_bridge_principal: Option<Option<Principal>>,
    pub whatsapp_verify_token: Option<Option<String>>,
    pub whatsapp_app_secret: Option<Option<String>>,
    pub whatsapp_access_token: Option<Option<String>>,
    pub whatsapp_phone_number_id: Option<Option<String>>,
    pub telegram_secret_token: Option<Option<String>>,
    pub telegram_bot_token: Option<Option<String>>,
    pub mail_bridge_url: Option<Option<String>>,
    pub mail_bridge_api_key: Option<Option<String>>,
    pub mail_from_address: Option<Option<String>>,
    pub system_prompt: Option<Option<String>>,
    pub llm_provider: Option<Option<String>>,
    pub llm_model: Option<Option<String>>,
    pub llm_api_key: Option<Option<String>>,
    pub max_output_tokens: Option<Option<u32>>,
    pub max_tool_iterations: Option<Option<u8>>,
    pub admin_webhook_url: Option<Option<String>>,
    pub admin_webhook_secret: Option<Option<String>>,
}

impl Config {
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.project_id {
            self.project_id = v;
        }
        if let Some(v) = update.protocol_id {
            self.protocol_id = v;
        }
        if let Some(v) = update.mail_bridge_principal {
            self.mail_bridge_principal = v;
        }
        if let Some(v) = update.whatsapp_verify_token {
            self.whatsapp_verify_token = v;
        }
        if let Some(v) = update.whatsapp_app_secret {
            self.whatsapp_app_secret = v;
        }
        if let Some(v) = update.whatsapp_access_token {
            self.whatsapp_access_token = v;
        }
        if let Some(v) = update.whatsapp_phone_number_id {
            self.whatsapp_phone_number_id = v;
        }
        if let Some(v) = update.telegram_secret_token {
            self.telegram_secret_token = v;
        }
        if let Some(v) = update.telegram_bot_token {
            self.telegram_bot_token = v;
        }
        if let Some(v) = update.mail_bridge_url {
            self.mail_bridge_url = v;
        }
        if let Some(v) = update.mail_bridge_api_key {
            self.mail_bridge_api_key = v;
        }
        if let Some(v) = update.mail_from_address {
            self.mail_from_address = v;
        }
        if let Some(v) = update.system_prompt {
            self.system_prompt = v;
        }
        if let Some(v) = update.llm_provider {
            self.llm_provider = v;
        }
        if let Some(v) = update.llm_model {
            self.llm_model = v;
        }
        if let Some(v) = update.llm_api_key {
            self.llm_api_key = v;
        }
        if let Some(v) = update.max_output_tokens {
            self.max_output_tokens = v;
        }
        if let Some(v) = update.max_tool_iterations {
            self.max_tool_iterations = v;
        }
        if let Some(v) = update.admin_webhook_url {
            self.admin_webhook_url = v;
        }
        if let Some(v) = update.admin_webhook_secret {
            self.admin_webhook_secret = v;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    #[test]
    fn project_context_resolves_by_package_name() {
        let context = ProjectContext {
            project_id: "project-1".to_string(),
            canisters: vec![ProjectCanister {
                canister_id: principal(7),
                package_name: "mail_bridge.wasm".to_string(),
            }],
        };
        assert_eq!(
            context.canister_for_package("mail_bridge.wasm"),
            Some(principal(7))
        );
        assert_eq!(context.canister_for_package("another-package"), None);
    }

    #[test]
    fn default_update_changes_nothing() {
        let config = Config {
            mail_bridge_principal: Some(principal(1)),
            system_prompt: Some("hi".to_string()),
            ..Default::default()
        };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn each_field_is_independently_settable_and_clearable() {
        let config = Config {
            mail_bridge_principal: Some(principal(1)),
            ..Default::default()
        };
        let updated = config.apply(ConfigUpdate {
            system_prompt: Some(Some("hello".to_string())),
            ..Default::default()
        });
        assert_eq!(updated.system_prompt.as_deref(), Some("hello"));
        assert_eq!(updated.mail_bridge_principal, Some(principal(1)));

        let cleared = updated.apply(ConfigUpdate {
            mail_bridge_principal: Some(None),
            ..Default::default()
        });
        assert_eq!(cleared.mail_bridge_principal, None);
        assert_eq!(
            cleared.system_prompt.as_deref(),
            Some("hello"),
            "unrelated field must be untouched"
        );
    }

    #[test]
    fn stable_config_ignores_removed_fields() {
        // Older deployed agents encoded these fields in the StableCell's
        // CBOR map. Serde's unknown-field behavior must keep those agents
        // upgradeable after the settings are removed.
        let mut stored = serde_json::to_value(Config::default()).unwrap();
        stored
            .as_object_mut()
            .unwrap()
            .insert("ic_sql_canister_id".to_string(), serde_json::Value::Null);
        stored.as_object_mut().unwrap().insert(
            "managed_ai_project_id".to_string(),
            serde_json::Value::String("legacy-project".to_string()),
        );
        let mut bytes = Vec::new();
        ciborium::into_writer(&stored, &mut bytes).unwrap();
        let restored: Config = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert_eq!(restored, Config::default());
    }
}
