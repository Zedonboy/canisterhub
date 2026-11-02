//! The `chat` tool-calling loop, via [`ic_rig`](https://github.com/Zedonboy/ic-rig).
//! See `agent/src/llm.rs`'s doc comment for why this template
//! uses a direct HTTPS outcall to a real provider (OpenAI/Anthropic/Gemini/
//! DeepSeek) rather than the on-chain LLM canister, and why that's also why
//! this canister needs no particular `ic-cdk` version pin.
//!
//! Unlike `agent`'s loop, this one is **stateless**: `chat` takes
//! the prior conversation as an argument and returns the whole updated
//! conversation, rather than persisting anything server-side - see
//! `lib.rs`'s doc comment for why that's the right call for this "simple
//! sample" and what a richer deployment might do differently.

use crate::config::Config;
use crate::tools::{IssueRefundTool, SetAccountStatusTool};
use ic_rig::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use ic_rig::{Agent, CompletionModel, Message};

pub const DEFAULT_MAX_TOOL_ITERATIONS: u32 = 4;

pub fn default_system_prompt() -> String {
    "You are an internal assistant for support/operations staff. You can issue \
     refunds and change customer account status using your tools. Always \
     confirm the specifics (order id, amount, customer reference) before \
     acting if the request is ambiguous, and briefly summarize what you did \
     after each action."
        .to_string()
}

/// [`ic_rig::http::HttpClient`] backed by the management canister's HTTPS
/// outcalls - identical to `agent`'s (see that crate's `llm.rs`
/// for the full doc comment on `is_replicated: Some(false)`).
#[derive(Clone)]
pub struct IcpClient;

impl HttpClient for IcpClient {
    type Error = HttpError;

    async fn post(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        use ic_cdk::management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

        let args = HttpRequestArgs {
            url: req.url,
            method: HttpMethod::POST,
            headers: req
                .headers
                .into_iter()
                .map(|(name, value)| HttpHeader { name, value })
                .collect(),
            body: Some(req.body),
            max_response_bytes: Some(65_536),
            transform: None,
            is_replicated: Some(false),
        };

        let resp = http_request(&args)
            .await
            .map_err(|e| HttpError(format!("{e:?}")))?;
        let status = resp.status.0.try_into().unwrap_or(u16::MAX);
        Ok(HttpResponse {
            status,
            body: resp.body,
        })
    }
}

fn default_model_for(provider: &str) -> &'static str {
    match provider {
        "anthropic" => ic_rig::providers::anthropic::CLAUDE_SONNET_5,
        "gemini" => ic_rig::providers::gemini::GEMINI_3_1_PRO_PREVIEW,
        "deepseek" => ic_rig::providers::deepseek::DEEPSEEK_V4_PRO,
        _ => ic_rig::providers::openai::GPT_5_6,
    }
}

/// Builds an [`Agent`] for whichever provider/model `config` names, with
/// both example tools attached, and calls `chat(prompt, history)`.
pub async fn run_agent_loop(
    config: &Config,
    history: Vec<Message>,
    prompt: &str,
) -> Result<String, String> {
    let Some(api_key) = config.llm_api_key.clone() else {
        return Err("llm_api_key is not configured".to_string());
    };
    let provider = config.llm_provider.as_deref().unwrap_or("openai");
    let model_id = config
        .llm_model
        .clone()
        .unwrap_or_else(|| default_model_for(provider).to_string());

    match provider {
        "openai" => {
            let client = ic_rig::providers::openai::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, history, prompt).await
        }
        "anthropic" => {
            let client = ic_rig::providers::anthropic::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, history, prompt).await
        }
        "gemini" => {
            let client = ic_rig::providers::gemini::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, history, prompt).await
        }
        "deepseek" => {
            let client = ic_rig::providers::deepseek::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, history, prompt).await
        }
        other => Err(format!(
            "unknown llm_provider '{other}' - expected one of openai/anthropic/gemini/deepseek"
        )),
    }
}

async fn run_with_model<M: CompletionModel>(
    model: M,
    config: &Config,
    history: Vec<Message>,
    prompt: &str,
) -> Result<String, String> {
    let preamble = config
        .system_prompt
        .clone()
        .unwrap_or_else(default_system_prompt);
    let max_iterations = config
        .max_tool_iterations
        .map(u32::from)
        .unwrap_or(DEFAULT_MAX_TOOL_ITERATIONS)
        .max(1);

    let agent = Agent::builder(model)
        .preamble(preamble)
        .tool(IssueRefundTool)
        .tool(SetAccountStatusTool)
        // Anthropic's API rejects a request with no `max_tokens` at all;
        // every other provider treats it as an optional cap. Set
        // unconditionally so switching `llm_provider` never breaks on this.
        .max_tokens(1024)
        .max_iterations(max_iterations)
        .build();

    agent.chat(prompt, history).await.map_err(|e| e.to_string())
}
