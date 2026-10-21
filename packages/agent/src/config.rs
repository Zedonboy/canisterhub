//! Every runtime parameter this canister needs, in one candid record -
//! passed whole to `init` and read back whole by `get_config`. Follows
//! `connector/src/config.rs`'s exact pattern, including `ConfigUpdate`'s
//! per-field, three-state partial update (see its own doc comment) via
//! `update_config` - kept identical across both canisters deliberately, so
//! an operator running both doesn't have to learn two conventions.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    /// The principal allowed to call `receive_message` - `connector`'s own
    /// identity. Every inbound customer message arrives this way; nothing
    /// else should be able to inject one.
    pub connector_principal: Option<Principal>,

    /// The system prompt prepended to every conversation - this is the main
    /// thing a business customizes: persona, tone, what the assistant is
    /// for, and (critically) an explicit statement of what it *can't* do
    /// (see `llm_context.md`'s "Writing a good system prompt" section). If
    /// unset, a generic fallback is used (see `llm::default_system_prompt`).
    pub system_prompt: Option<String>,
    /// Which LLM provider to call - one of `"openai"` (default),
    /// `"anthropic"`, `"gemini"`, `"deepseek"` (each makes its own HTTPS
    /// outcall directly to that provider's API, and needs `llm_api_key`),
    /// or `"platform"` (the real on-chain LLM canister via `ic_llm` - no API
    /// key, but only DFINITY's own hosted models and that canister's own
    /// prompt/token/message caps) - see `llm.rs`'s doc comment for the full
    /// tradeoff.
    pub llm_provider: Option<String>,
    /// Provider-specific model id (e.g. `"gpt-5.6-sol"`, `"claude-sonnet-5"`,
    /// `"gemini-3.1-pro-preview"`, `"deepseek-v4-pro"`, or - for `"platform"` -
    /// `"llama3.1:8b"`/`"qwen3:32b"`/`"llama4-scout"`/`"qwen2.5:0.5b"`
    /// (free) / `"gemma3:27b"`/`"z-ai:glm-5.2"` (paid, drawn from this
    /// canister's own cycles balance)) - defaults to that provider's
    /// flagship model if unset (see `llm::default_model_for`).
    pub llm_model: Option<String>,
    /// API key for whichever HTTPS `llm_provider` is configured - not used
    /// at all for `"platform"` (see that variant's own doc comment above).
    /// Required for every other provider: `receive_message` returns an
    /// error (which becomes an `request_admin_action`-style escalation -
    /// see `llm::run_agent_loop`) if this is unset.
    pub llm_api_key: Option<String>,
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

    /// The `ic-sql` canister (`packages/ic-sql`) this deployment's
    /// `query_database` tool reads from, if any - see `db.rs` and
    /// `tools.rs::QueryDatabaseTool`. Unset = the tool is still registered
    /// (so the model can attempt it and get a clear error) but every call
    /// fails immediately rather than reaching for a canister id that isn't
    /// there.
    pub ic_sql_canister_id: Option<Principal>,
}

/// `update_config`'s argument - see `Config`'s doc comment. Semantics
/// (three states per field) are identical to `connector`'s `ConfigUpdate`;
/// see that type's doc comment for the full explanation.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub connector_principal: Option<Option<Principal>>,
    pub system_prompt: Option<Option<String>>,
    pub llm_provider: Option<Option<String>>,
    pub llm_model: Option<Option<String>>,
    pub llm_api_key: Option<Option<String>>,
    pub max_tool_iterations: Option<Option<u8>>,
    pub admin_webhook_url: Option<Option<String>>,
    pub admin_webhook_secret: Option<Option<String>>,
    pub ic_sql_canister_id: Option<Option<Principal>>,
}

impl Config {
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.connector_principal {
            self.connector_principal = v;
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
        if let Some(v) = update.max_tool_iterations {
            self.max_tool_iterations = v;
        }
        if let Some(v) = update.admin_webhook_url {
            self.admin_webhook_url = v;
        }
        if let Some(v) = update.admin_webhook_secret {
            self.admin_webhook_secret = v;
        }
        if let Some(v) = update.ic_sql_canister_id {
            self.ic_sql_canister_id = v;
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
    fn default_update_changes_nothing() {
        let config = Config { connector_principal: Some(principal(1)), system_prompt: Some("hi".to_string()), ..Default::default() };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn each_field_is_independently_settable_and_clearable() {
        let config = Config { connector_principal: Some(principal(1)), ..Default::default() };
        let updated = config.apply(ConfigUpdate { system_prompt: Some(Some("hello".to_string())), ..Default::default() });
        assert_eq!(updated.system_prompt.as_deref(), Some("hello"));
        assert_eq!(updated.connector_principal, Some(principal(1)));

        let cleared = updated.apply(ConfigUpdate { connector_principal: Some(None), ..Default::default() });
        assert_eq!(cleared.connector_principal, None);
        assert_eq!(cleared.system_prompt.as_deref(), Some("hello"), "unrelated field must be untouched");
    }
}
