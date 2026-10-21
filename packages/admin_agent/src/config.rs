//! Runtime configuration - same one-record, tri-state-partial-update
//! pattern as `connector`/`agent` (see either's `config.rs` for
//! the full explanation). The one thing worth noting here specifically:
//! `admins` replaces the *entire* list on update, same as every other
//! field - there's no add-one/remove-one method. For a small,
//! infrequently-changed admin list that's simpler than it costs; a
//! deployment managing a large or frequently-changing admin set should
//! swap this for its own membership store.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Config {
    /// Principals allowed to call any gated method here - every direct
    /// candid action method and `chat`. A controller may always call them
    /// too (see `require_admin`), so this can be empty while a deployment
    /// is still using controller-only access during setup.
    pub admins: Vec<Principal>,
    /// System prompt for `chat` - see `llm_context.md`'s "Writing a good
    /// system prompt" section. Falls back to a generic prompt if unset.
    pub system_prompt: Option<String>,
    /// Which LLM provider `chat` calls - one of `"openai"` (default),
    /// `"anthropic"`, `"gemini"`, `"deepseek"`. Each makes its own HTTPS
    /// outcall directly to that provider's API - see `llm.rs`'s doc comment.
    pub llm_provider: Option<String>,
    /// Provider-specific model id (e.g. `"gpt-5.6-sol"`, `"claude-sonnet-5"`)
    /// - defaults to that provider's flagship model if unset (see
    ///   `llm::default_model_for`).
    pub llm_model: Option<String>,
    /// API key for whichever `llm_provider` is configured. Required: `chat`
    /// returns an error if this is unset.
    pub llm_api_key: Option<String>,
    /// LLM <-> tool round trips one `chat` call may make before returning
    /// whatever it has rather than looping further. Defaults to
    /// `llm::DEFAULT_MAX_TOOL_ITERATIONS` if unset.
    pub max_tool_iterations: Option<u8>,
}

/// `update_config`'s argument - see `connector::config::ConfigUpdate`'s doc
/// comment for the exact three-state-per-field semantics this mirrors.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub admins: Option<Vec<Principal>>,
    pub system_prompt: Option<Option<String>>,
    pub llm_provider: Option<Option<String>>,
    pub llm_model: Option<Option<String>>,
    pub llm_api_key: Option<Option<String>>,
    pub max_tool_iterations: Option<Option<u8>>,
}

impl Config {
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.admins {
            self.admins = v;
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
        let config = Config { admins: vec![principal(1)], system_prompt: Some("hi".to_string()), ..Default::default() };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn admins_replaces_the_whole_list() {
        let config = Config { admins: vec![principal(1)], ..Default::default() };
        let updated = config.apply(ConfigUpdate { admins: Some(vec![principal(2), principal(3)]), ..Default::default() });
        assert_eq!(updated.admins, vec![principal(2), principal(3)]);
    }

    #[test]
    fn each_scalar_field_is_independently_settable_and_clearable() {
        let config = Config { system_prompt: Some("a".to_string()), ..Default::default() };
        let updated = config.apply(ConfigUpdate { llm_model: Some(Some("qwen3:32b".to_string())), ..Default::default() });
        assert_eq!(updated.llm_model.as_deref(), Some("qwen3:32b"));
        assert_eq!(updated.system_prompt.as_deref(), Some("a"), "unrelated field must be untouched");

        let cleared = updated.apply(ConfigUpdate { system_prompt: Some(None), ..Default::default() });
        assert_eq!(cleared.system_prompt, None);
    }
}
