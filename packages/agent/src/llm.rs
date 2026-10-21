//! The LLM <-> tool-calling loop, via [`ic_rig`](https://github.com/Zedonboy/ic-rig)
//! and, for `llm_provider = "platform"`, [`ic_llm`](https://github.com/dfinity/llm).
//!
//! # Two provider families, one loop
//!
//! `ic_rig` makes its own HTTPS outcall straight to whichever HTTPS
//! provider's API you configure (OpenAI, Anthropic, Gemini, or DeepSeek -
//! see [`Config::llm_provider`]) - the tradeoff for needing your own API key
//! is real model choice (GPT-5.6, Claude, Gemini, DeepSeek) and none of the
//! on-chain LLM canister's prompt-size/output-token/message-count caps.
//! `ic_rig` has no bundled HTTP client - [`IcpClient`] below implements one
//! for it.
//!
//! `ic_llm` instead makes a plain inter-canister call to the real on-chain
//! LLM canister (`w36hm-eqaaa-aaaal-qr76a-cai` on mainnet, or a local
//! Ollama-backed one - see [`ic_llm`'s own docs](https://docs.rs/ic-llm) on
//! `icp deploy`'s `PUBLIC_CANISTER_ID:llm` auto-injection) - no API key, no
//! HTTPS outcall, at the cost of only DFINITY's own hosted models and that
//! canister's own request-size/schema limits (see [`IcLlmModel`]'s own doc
//! comment). [`IcLlmModel`] below adapts it to the exact same
//! [`ic_rig::CompletionModel`] trait the HTTPS providers implement, so
//! everything downstream - the tool-calling loop, [`TrackingModel`]'s usage
//! accounting, [`run_with_model`] - works identically either way. Note: a
//! `"platform"`-configured request traps the whole call if this canister's
//! own cycles balance is below 100B when `send()` runs (`ic_llm` always
//! attaches that much, even for a free model - see its own README) - a
//! real, disclosed operational requirement, not a bug if it happens.
//!
//! # The loop itself
//!
//! `ic_rig::Agent::chat` already implements the full completion <-> tool
//! dispatch loop internally (see its own doc comment) - this module's job
//! is just: pick a provider/model from [`Config`], build an [`Agent`] with
//! this conversation's tools (each holding the current `SessionKey` - see
//! `tools.rs`'s doc comment for why), and call `chat`.

use crate::config::Config;
use crate::messages::SessionKey;
use crate::tools::{GetProfileTool, QueryDatabaseTool, RequestAdminActionTool, UpdateUsernameTool};
use ic_rig::completion::{CompletionRequest, CompletionResponse, ModelChoice, Usage};
use ic_rig::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use ic_rig::message::{AssistantContent, ToolCall as RigToolCall, UserContent};
use ic_rig::tool::ToolDefinition;
use ic_rig::{Agent, CompletionModel, Message};
use std::cell::Cell;
use std::rc::Rc;

/// Wraps a real provider [`CompletionModel`] to accumulate the token usage
/// each completion call reports, into `totals` (shared with the caller via
/// `Rc` so it's still readable after this wrapper - and the `Agent` it was
/// built into - are dropped). `Agent::chat`'s own internal tool-calling loop
/// can call `complete` several times for one `run_agent_loop` turn (once per
/// tool-call round); this accumulates across all of them. `Cell`, not
/// `RefCell`: a canister's execution model has no real concurrency (no two
/// `&self` methods ever run interleaved on the same instance), so a plain
/// get/set pair here can't race the way it could in a threaded host.
struct TrackingModel<M> {
    inner: M,
    totals: Rc<Cell<(u64, u64)>>,
}

impl<M: CompletionModel> CompletionModel for TrackingModel<M> {
    type Error = M::Error;

    async fn complete(&self, request: CompletionRequest) -> Result<CompletionResponse, Self::Error> {
        let response = self.inner.complete(request).await?;
        if let Some(usage) = &response.usage {
            let (prompt, completion) = self.totals.get();
            self.totals.set((prompt + u64::from(usage.prompt_tokens), completion + u64::from(usage.completion_tokens)));
        }
        Ok(response)
    }
}

pub const DEFAULT_MAX_TOOL_ITERATIONS: u32 = 4;

/// Used when `Config::system_prompt` is unset. A real deployment should
/// always set its own - see `llm_context.md`'s "Writing a good system
/// prompt" section - this exists so the template still does something
/// reasonable (and, importantly, still states its own limits) before an
/// implementer has customized it.
pub fn default_system_prompt() -> String {
    "You are a customer support assistant. You can look up and change only the \
     account of the person you are currently talking to - you have no way to \
     access or affect any other customer's data, and no administrative \
     abilities (refunds, account deletion, and similar requests must go \
     through request_admin_action). If a database is configured for this \
     deployment, you can also use query_database to look up read-only \
     information (e.g. order status or product details) with a SELECT \
     statement - never to change anything. Be concise, honest about what you \
     can and cannot do, and use request_admin_action rather than guessing or \
     refusing outright when a request is legitimate but outside your other \
     tools."
        .to_string()
}

/// [`ic_rig::http::HttpClient`] backed by the management canister's HTTPS
/// outcalls. `Clone` (zero-sized, trivial) because `ic_rig`'s provider
/// clients require it - they clone this into each `Model` they hand out.
#[derive(Clone)]
pub struct IcpClient;

impl HttpClient for IcpClient {
    type Error = HttpError;

    async fn post(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        use ic_cdk_management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

        let args = HttpRequestArgs {
            url: req.url,
            method: HttpMethod::POST,
            headers: req.headers.into_iter().map(|(name, value)| HttpHeader { name, value }).collect(),
            body: Some(req.body),
            // A completion response (including any tool calls) is at most a
            // few KB of JSON for the tools this template registers - well
            // under this, but sized with headroom for a verbose reply.
            max_response_bytes: Some(65_536),
            transform: None,
            // Every LLM completion call is a billed, non-deterministic
            // (temperature > 0) request to a third-party API - replicating
            // it across the subnet would both multiply the bill by the
            // subnet size and near-guarantee the replicas' responses don't
            // match byte-for-byte, so consensus would never be reached
            // without a transform discarding the content itself. A single
            // replica is the only sensible choice here - same reasoning as
            // `admin.rs::notify_admin_webhook` and every outbound send in
            // `connector` (see that canister's `outbound.rs`).
            is_replicated: Some(false),
        };

        let resp = http_request(&args).await.map_err(|e| HttpError(format!("{e:?}")))?;
        let status = resp.status.0.try_into().unwrap_or(u16::MAX);
        Ok(HttpResponse { status, body: resp.body })
    }
}

fn default_model_for(provider: &str) -> &'static str {
    match provider {
        "anthropic" => ic_rig::providers::anthropic::CLAUDE_SONNET_5,
        "gemini" => ic_rig::providers::gemini::GEMINI_3_1_PRO_PREVIEW,
        "deepseek" => ic_rig::providers::deepseek::DEEPSEEK_V4_PRO,
        // Free, per `ic_llm`'s own README - a sane no-cost default,
        // matching the spirit of every other provider's own free-tier-ish
        // flagship pick above.
        "platform" => "llama3.1:8b",
        _ => ic_rig::providers::openai::GPT_5_6,
    }
}

// ---------------------------------------------------------------------------
// The on-chain LLM canister, adapted to `CompletionModel` (`llm_provider =
// "platform"`) - see this module's own doc comment for the real tradeoff.
// ---------------------------------------------------------------------------

/// Errors specific to the `IcLlmModel` adapter - everything else (the
/// inter-canister call itself failing, e.g. insufficient cycles) is a trap
/// on `ic_llm`'s own side (see its README), not a `Result::Err` this type
/// could catch.
#[derive(Debug, thiserror::Error)]
pub enum IcLlmError {
    /// The on-chain LLM canister's own tool schema (see [`convert_tool`]'s
    /// doc comment) can't represent this tool's real JSON Schema.
    #[error("tool '{0}' has a parameter schema the on-chain LLM canister can't represent (only flat string/number/boolean properties, no arrays or nested objects)")]
    UnsupportedToolSchema(String),
    /// `ic_llm` returned a message with neither text nor a tool call -
    /// shouldn't happen against a real, working LLM canister, but the
    /// candid type technically allows it.
    #[error("the on-chain LLM canister returned neither a text reply nor a tool call")]
    EmptyResponse,
}

/// Adapts [`ic_llm`]'s own chat API to [`ic_rig`]'s [`CompletionModel`], so
/// [`run_with_model`] (and everything it drives - the tool-calling loop,
/// [`TrackingModel`]'s usage accounting) works identically whether an
/// HTTPS provider or the on-chain canister is configured.
///
/// One real, disclosed gap: `ic_llm::tool::Parameters` only supports flat
/// string/number/boolean properties - no arrays or nested objects, unlike
/// the full JSON Schema `ic_rig::tool::ToolDefinition::parameters` allows.
/// Every tool this template ships (`tools.rs`) only ever declares flat
/// string parameters, so this is a non-issue today; [`convert_tool`]
/// returns a real `IcLlmError` (surfaced as this turn's own escalation,
/// same as any other completion failure) rather than silently dropping or
/// mangling a schema it can't represent, if a future custom tool ever needs
/// something richer while `llm_provider = "platform"` is configured.
///
/// Also real and disclosed: `ic_llm`'s own `Response` never reports token
/// usage (no such field on the wire) - `TrackingModel` simply accumulates
/// nothing for these calls, which is why `AgentStats`'s own doc comment
/// already says `0` doesn't necessarily mean "no completion happened".
pub struct IcLlmModel {
    model: String,
}

impl IcLlmModel {
    pub fn new(model: impl Into<String>) -> Self {
        Self { model: model.into() }
    }
}

impl CompletionModel for IcLlmModel {
    type Error = IcLlmError;

    async fn complete(&self, request: CompletionRequest) -> Result<CompletionResponse, Self::Error> {
        let messages = convert_messages(request.messages);
        let tools = request.tools.into_iter().map(convert_tool).collect::<Result<Vec<_>, _>>()?;

        let response = ic_llm::chat(self.model.clone()).with_messages(messages).with_tools(tools).send().await;

        parse_response(response)
    }
}

/// Flattens `ic_rig`'s per-turn content lists into `ic_llm`'s own flat
/// per-role messages - see `ic_rig::providers::openai`'s own
/// `convert_messages` for the same flattening pattern against a different
/// wire format. In practice `ic_rig::Agent::chat` only ever produces a
/// `User` turn that's *either* one `Text` (a fresh prompt) *or* one-or-more
/// `ToolResult`s (a tool-call round's results), never mixed - but this
/// handles the general case defensively rather than assuming that.
fn convert_messages(messages: Vec<Message>) -> Vec<ic_llm::ChatMessage> {
    let mut out = Vec::new();

    for msg in messages {
        match msg {
            Message::System { content } => out.push(ic_llm::ChatMessage::System { content }),

            Message::User { content } => {
                let mut text_parts: Vec<String> = Vec::new();
                for part in content {
                    match part {
                        UserContent::Text(t) => text_parts.push(t.text),
                        UserContent::ToolResult(r) => {
                            if !text_parts.is_empty() {
                                out.push(ic_llm::ChatMessage::User { content: std::mem::take(&mut text_parts).join("\n\n") });
                            }
                            out.push(ic_llm::ChatMessage::Tool { content: r.content, tool_call_id: r.call_id });
                        }
                    }
                }
                if !text_parts.is_empty() {
                    out.push(ic_llm::ChatMessage::User { content: text_parts.join("\n\n") });
                }
            }

            Message::Assistant { content } => {
                let mut text: Option<String> = None;
                let mut tool_calls: Vec<ic_llm::ToolCall> = Vec::new();
                for part in content {
                    match part {
                        AssistantContent::Text(t) => text = Some(t.text),
                        AssistantContent::ToolCall(c) => tool_calls.push(convert_rig_tool_call(c)),
                    }
                }
                out.push(ic_llm::ChatMessage::Assistant(ic_llm::AssistantMessage { content: text, tool_calls }));
            }
        }
    }

    out
}

fn convert_rig_tool_call(call: RigToolCall) -> ic_llm::ToolCall {
    let arguments: Vec<serde_json::Value> = match call.arguments {
        serde_json::Value::Object(map) => {
            map.into_iter().map(|(name, v)| serde_json::json!({ "name": name, "value": json_value_to_wire_string(&v) })).collect()
        }
        other => vec![serde_json::json!({ "name": "value", "value": json_value_to_wire_string(&other) })],
    };
    // `ic_llm::chat::ToolCallArgument` (the element type of
    // `FunctionCall::arguments`) is a private type inside `ic_llm`'s own
    // non-public `chat` module - not reachable from outside the crate at
    // all, even though `ToolCall`/`FunctionCall` themselves are public.
    // Building the value through `ToolCall`'s own `Deserialize` impl
    // (which it derives) sidesteps that: serde constructs the private
    // `ToolCallArgument` values internally while deserializing, without
    // this function ever needing to name that type itself.
    serde_json::from_value(serde_json::json!({ "id": call.id, "function": { "name": call.name, "arguments": arguments } }))
        .expect("ic_llm::ToolCall's own shape round-trips through the JSON this function itself builds")
}

fn json_value_to_wire_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Converts one `ic_rig::tool::ToolDefinition` (a full JSON Schema
/// `parameters` object) into `ic_llm`'s own flat schema - see
/// [`IcLlmModel`]'s own doc comment on the real, disclosed limitation this
/// enforces rather than works around.
fn convert_tool(def: ToolDefinition) -> Result<ic_llm::Tool, IcLlmError> {
    let unsupported = || IcLlmError::UnsupportedToolSchema(def.name.clone());

    let properties_obj = def.parameters.get("properties").and_then(|p| p.as_object());
    let required: Vec<&str> = def
        .parameters
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    let mut builder = ic_llm::ToolBuilder::new(def.name.clone()).with_description(def.description);

    if let Some(props) = properties_obj {
        for (name, schema) in props {
            let type_str = schema.get("type").and_then(|t| t.as_str()).ok_or_else(unsupported)?;
            let param_type = match type_str {
                "string" => ic_llm::ParameterType::String,
                "boolean" => ic_llm::ParameterType::Boolean,
                "number" | "integer" => ic_llm::ParameterType::Number,
                _ => return Err(unsupported()),
            };

            let mut param = ic_llm::ParameterBuilder::new(name.clone(), param_type);
            if let Some(desc) = schema.get("description").and_then(|d| d.as_str()) {
                param = param.with_description(desc);
            }
            if let Some(values) = schema.get("enum").and_then(|e| e.as_array()) {
                param = param.with_enum_values(values.iter().filter_map(|v| v.as_str().map(str::to_string)));
            }
            if required.contains(&name.as_str()) {
                param = param.is_required();
            }
            builder = builder.with_parameter(param);
        }
    } else if def.parameters.get("type").and_then(|t| t.as_str()) != Some("object") {
        // Every real schema this template's tools declare is `{"type":
        // "object", "properties": {...}}` (see `tools.rs`) - anything not
        // even shaped like that (e.g. a schema built around `oneOf`/
        // `anyOf`/`items`) has no flat-property translation at all.
        return Err(unsupported());
    }

    Ok(builder.build())
}

fn parse_response(response: ic_llm::Response) -> Result<CompletionResponse, IcLlmError> {
    let msg = response.message;
    let choice = if !msg.tool_calls.is_empty() {
        ModelChoice::ToolCall(msg.tool_calls.into_iter().map(convert_ic_llm_tool_call).collect())
    } else if let Some(text) = msg.content {
        ModelChoice::Message(text)
    } else {
        return Err(IcLlmError::EmptyResponse);
    };

    // `ic_llm::Response` never reports token usage - see `IcLlmModel`'s own
    // doc comment.
    Ok(CompletionResponse { choice, reasoning: None, usage: None::<Usage> })
}

fn convert_ic_llm_tool_call(call: ic_llm::ToolCall) -> RigToolCall {
    let mut arguments = serde_json::Map::new();
    for arg in call.function.arguments {
        arguments.insert(arg.name, wire_string_to_json_value(&arg.value));
    }
    RigToolCall { id: call.id, name: call.function.name, arguments: serde_json::Value::Object(arguments) }
}

/// `ic_llm::ToolCallArgument::value` is always a plain string on the wire,
/// regardless of the parameter's declared type - best-effort recovers a
/// real number/bool when the text looks like one, falling back to a JSON
/// string otherwise. Every tool this template ships only ever declares
/// string parameters (see `tools.rs`), so this only matters for a possible
/// future non-string one.
fn wire_string_to_json_value(s: &str) -> serde_json::Value {
    if s == "true" {
        return serde_json::Value::Bool(true);
    }
    if s == "false" {
        return serde_json::Value::Bool(false);
    }
    if let Ok(n) = s.parse::<i64>() {
        return serde_json::Value::Number(n.into());
    }
    if let Ok(f) = s.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            return serde_json::Value::Number(n);
        }
    }
    serde_json::Value::String(s.to_string())
}

/// Runs one full turn: builds an [`Agent`] for whichever provider/model
/// `config` names, with this conversation's tools attached (each scoped to
/// `customer` - see `tools.rs`), and calls `chat(prompt, history)`.
///
/// On `AgentError::MaxIterations` (the model wouldn't stop calling tools),
/// falls back to filing the same kind of request `request_admin_action`
/// would, rather than leaving the customer with no reply at all - see
/// `admin::file_and_notify`.
pub async fn run_agent_loop(customer: &SessionKey, config: &Config, history: Vec<Message>, prompt: &str) -> String {
    let result = dispatch(customer, config, history, prompt).await;
    match result {
        Ok(text) => text,
        Err(e) => {
            let details = format!("Automated escalation: {e} (message: {prompt})");
            match crate::admin::file_and_notify(customer, "unresolved_conversation", &details).await {
                Ok(msg) => msg,
                Err(_) => "I'm having trouble completing this right now - please try again shortly.".to_string(),
            }
        }
    }
}

async fn dispatch(customer: &SessionKey, config: &Config, history: Vec<Message>, prompt: &str) -> Result<String, String> {
    let provider = config.llm_provider.as_deref().unwrap_or("openai");
    let model_id = config.llm_model.clone().unwrap_or_else(|| default_model_for(provider).to_string());

    // `"platform"` needs no API key at all (see this module's own doc
    // comment) - every other provider does, so the check lives here rather
    // than unconditionally before the match.
    if provider == "platform" {
        return run_with_model(IcLlmModel::new(model_id), config, customer, history, prompt).await;
    }
    let Some(api_key) = config.llm_api_key.clone() else {
        return Err("llm_api_key is not configured".to_string());
    };

    match provider {
        "openai" => {
            let client = ic_rig::providers::openai::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, customer, history, prompt).await
        }
        "anthropic" => {
            let client = ic_rig::providers::anthropic::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, customer, history, prompt).await
        }
        "gemini" => {
            let client = ic_rig::providers::gemini::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, customer, history, prompt).await
        }
        "deepseek" => {
            let client = ic_rig::providers::deepseek::Client::new(IcpClient, api_key);
            run_with_model(client.model(model_id), config, customer, history, prompt).await
        }
        other => Err(format!("unknown llm_provider '{other}' - expected one of openai/anthropic/gemini/deepseek/platform")),
    }
}

async fn run_with_model<M: CompletionModel>(model: M, config: &Config, customer: &SessionKey, history: Vec<Message>, prompt: &str) -> Result<String, String> {
    let preamble = config.system_prompt.clone().unwrap_or_else(default_system_prompt);
    let max_iterations = config.max_tool_iterations.map(u32::from).unwrap_or(DEFAULT_MAX_TOOL_ITERATIONS).max(1);

    // Recorded into `AgentStats` below regardless of how `chat` turns
    // out - see `TrackingModel`'s doc comment.
    let usage_totals = Rc::new(Cell::new((0u64, 0u64)));
    let tracked_model = TrackingModel { inner: model, totals: usage_totals.clone() };

    let agent = Agent::builder(tracked_model)
        .preamble(preamble)
        .tool(GetProfileTool { customer: customer.clone() })
        .tool(UpdateUsernameTool { customer: customer.clone() })
        .tool(QueryDatabaseTool { customer: customer.clone(), ic_sql_canister_id: config.ic_sql_canister_id })
        .tool(RequestAdminActionTool { customer: customer.clone() })
        // Anthropic's API rejects a request with no `max_tokens` at all;
        // every other provider treats it as an optional cap. Set
        // unconditionally so switching `llm_provider` never breaks on this.
        .max_tokens(1024)
        .max_iterations(max_iterations)
        .build();

    let result = agent.chat(prompt, history).await.map_err(|e| e.to_string());
    let (prompt_tokens, completion_tokens) = usage_totals.get();
    crate::state::record_usage(prompt_tokens, completion_tokens);
    result
}

#[cfg(test)]
mod ic_llm_model_tests {
    use super::*;
    use crate::messages::{Channel, SessionKey};
    use crate::tools::{GetProfileTool, QueryDatabaseTool, RequestAdminActionTool, UpdateUsernameTool};
    use ic_llm::{AssistantMessage, ChatMessage, Response};
    use ic_rig::tool::Tool as _;

    fn key(id: &str) -> SessionKey {
        SessionKey { channel: Channel::WhatsApp, session_id: id.to_string() }
    }

    // ── convert_tool ─────────────────────────────────────────────────────

    /// The real, disclosed limitation (`IcLlmModel`'s own doc comment)
    /// asserts every tool this template ships is flat-string-only - verify
    /// that directly against `tools.rs`'s own real definitions, not just
    /// assume it.
    #[test]
    fn convert_tool_succeeds_on_every_real_tool_schema() {
        let customer = key("probe");
        let defs = [
            GetProfileTool { customer: customer.clone() }.definition(),
            UpdateUsernameTool { customer: customer.clone() }.definition(),
            QueryDatabaseTool { customer: customer.clone(), ic_sql_canister_id: None }.definition(),
            RequestAdminActionTool { customer }.definition(),
        ];
        for def in defs {
            let name = def.name.clone();
            assert!(convert_tool(def).is_ok(), "convert_tool failed on the real '{name}' schema");
        }
    }

    #[test]
    fn convert_tool_carries_description_required_and_enum_through() {
        let def = ToolDefinition {
            name: "set_status".to_string(),
            description: "Set the order status.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "description": "New status", "enum": ["open", "closed"] },
                    "note": { "type": "string" }
                },
                "required": ["status"]
            }),
        };
        let tool = convert_tool(def).unwrap();
        let ic_llm::Tool::Function(f) = tool;
        assert_eq!(f.name, "set_status");
        assert_eq!(f.description.as_deref(), Some("Set the order status."));
        let params = f.parameters.unwrap();
        assert_eq!(params.required.as_deref(), Some(["status".to_string()].as_slice()));
        let status_prop = params.properties.as_ref().unwrap().iter().find(|p| p.name == "status").unwrap();
        assert_eq!(status_prop.enum_.as_deref(), Some(["open".to_string(), "closed".to_string()].as_slice()));
    }

    #[test]
    fn convert_tool_rejects_an_array_typed_property() {
        let def = ToolDefinition {
            name: "bulk_op".to_string(),
            description: "d".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "ids": { "type": "array", "items": { "type": "string" } } },
                "required": []
            }),
        };
        assert!(matches!(convert_tool(def), Err(IcLlmError::UnsupportedToolSchema(name)) if name == "bulk_op"));
    }

    #[test]
    fn convert_tool_rejects_a_schema_with_no_object_properties_at_all() {
        let def = ToolDefinition { name: "weird".to_string(), description: "d".to_string(), parameters: serde_json::json!({ "type": "oneOf" }) };
        assert!(convert_tool(def).is_err());
    }

    // ── convert_messages ─────────────────────────────────────────────────

    #[test]
    fn convert_messages_maps_system_and_plain_user_text() {
        let out = convert_messages(vec![Message::system("be nice"), Message::user("hello")]);
        assert_eq!(out, vec![ChatMessage::System { content: "be nice".to_string() }, ChatMessage::User { content: "hello".to_string() }]);
    }

    #[test]
    fn convert_messages_turns_tool_results_into_separate_tool_messages_not_a_user_message() {
        let msg = Message::User {
            content: vec![
                UserContent::ToolResult(ic_rig::message::ToolResult { call_id: "1".to_string(), name: "a".to_string(), content: "ok".to_string() }),
                UserContent::ToolResult(ic_rig::message::ToolResult { call_id: "2".to_string(), name: "b".to_string(), content: "also ok".to_string() }),
            ],
        };
        let out = convert_messages(vec![msg]);
        assert_eq!(
            out,
            vec![
                ChatMessage::Tool { content: "ok".to_string(), tool_call_id: "1".to_string() },
                ChatMessage::Tool { content: "also ok".to_string(), tool_call_id: "2".to_string() },
            ]
        );
    }

    #[test]
    fn convert_messages_keeps_an_assistants_text_and_tool_calls_in_one_message() {
        let msg = Message::Assistant {
            content: vec![
                AssistantContent::Text(ic_rig::message::Text { text: "checking...".to_string() }),
                AssistantContent::ToolCall(RigToolCall { id: "call-1".to_string(), name: "get_profile".to_string(), arguments: serde_json::json!({}) }),
            ],
        };
        let out = convert_messages(vec![msg]);
        assert_eq!(out.len(), 1);
        let ChatMessage::Assistant(AssistantMessage { content, tool_calls }) = &out[0] else { panic!("expected an Assistant message") };
        assert_eq!(content.as_deref(), Some("checking..."));
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call-1");
        assert_eq!(tool_calls[0].function.name, "get_profile");
    }

    // ── tool-call argument round trip ────────────────────────────────────

    #[test]
    fn tool_call_arguments_round_trip_through_both_conversions() {
        let original = RigToolCall {
            id: "call-9".to_string(),
            name: "update_username".to_string(),
            arguments: serde_json::json!({ "new_username": "bob", "retries": 2, "confirmed": true }),
        };
        let wire = convert_rig_tool_call(original.clone());
        let back = convert_ic_llm_tool_call(wire);
        assert_eq!(back.id, original.id);
        assert_eq!(back.name, original.name);
        assert_eq!(back.arguments, original.arguments);
    }

    #[test]
    fn wire_string_to_json_value_recovers_real_types() {
        assert_eq!(wire_string_to_json_value("true"), serde_json::Value::Bool(true));
        assert_eq!(wire_string_to_json_value("false"), serde_json::Value::Bool(false));
        assert_eq!(wire_string_to_json_value("42"), serde_json::json!(42));
        assert_eq!(wire_string_to_json_value("3.5"), serde_json::json!(3.5));
        assert_eq!(wire_string_to_json_value("bob"), serde_json::Value::String("bob".to_string()));
    }

    // ── parse_response ───────────────────────────────────────────────────

    #[test]
    fn parse_response_prefers_tool_calls_over_text_when_both_are_present() {
        let response = Response {
            message: AssistantMessage {
                content: Some("ignored".to_string()),
                tool_calls: vec![convert_rig_tool_call(RigToolCall { id: "1".to_string(), name: "get_profile".to_string(), arguments: serde_json::json!({}) })],
            },
        };
        let parsed = parse_response(response).unwrap();
        assert!(matches!(parsed.choice, ModelChoice::ToolCall(calls) if calls.len() == 1));
    }

    #[test]
    fn parse_response_returns_text_when_there_are_no_tool_calls() {
        let response = Response { message: AssistantMessage { content: Some("hi there".to_string()), tool_calls: vec![] } };
        let parsed = parse_response(response).unwrap();
        assert!(matches!(parsed.choice, ModelChoice::Message(text) if text == "hi there"));
        assert!(parsed.usage.is_none(), "ic_llm reports no token usage - see IcLlmModel's own doc comment");
    }

    #[test]
    fn parse_response_errors_when_neither_text_nor_tool_calls() {
        let response = Response { message: AssistantMessage { content: None, tool_calls: vec![] } };
        assert!(matches!(parse_response(response), Err(IcLlmError::EmptyResponse)));
    }

    #[test]
    fn default_model_for_platform_is_a_free_model() {
        // Free per `ic_llm`'s own README - see `default_model_for`'s doc
        // comment on why this specific one was picked.
        assert_eq!(default_model_for("platform"), "llama3.1:8b");
    }
}
