//! Controller-funded, account-scoped access to external AI providers.
//!
//! Agent calls are authorized from the calling canister's certified controller
//! set. The controller with a `SystemAccount` pays for the call, independent
//! of any project registry entry. Provider-reported tokens remain persisted by
//! account and consumer principal for upgrade-safe billing.

use super::{Memory, PROJECTS};
use candid::{CandidType, Principal};
use ic_rig::completion::{CompletionModel, CompletionRequest, ModelChoice};
use ic_rig::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use ic_rig::message::{AssistantContent, Message, ToolCall as RigToolCall, UserContent};
use ic_rig::tool::ToolDefinition;
use ic_stable_structures::{
    memory_manager::MemoryId, storable::Bound, StableBTreeMap, StableCell, Storable,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::BTreeSet;

// Keep managed AI in a distant reserved range. IDs 9-17 have existed in
// earlier backend layouts (including the removed push implementation), so
// reusing an apparently vacant one can decode unrelated legacy bytes.
const USAGE_MEM_ID: MemoryId = MemoryId::new(64);
const CONFIG_MEM_ID: MemoryId = MemoryId::new(65);
const ACCOUNTS_MEM_ID: MemoryId = MemoryId::new(66);
const MAX_PROJECT_ID_BYTES: usize = 128;
const MAX_SYSTEM_PROMPT_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_MESSAGES: usize = 128;
const MAX_TOOLS: usize = 64;
const MAX_OUTPUT_TOKENS: u32 = 4_096;
const MAX_API_KEY_BYTES: usize = 16 * 1024;
const MAX_MODEL_BYTES: usize = 256;

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize)]
struct ManagedAiConfig {
    enabled: bool,
    provider: String,
    model: String,
    api_key: String,
}

impl Storable for ManagedAiConfig {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode managed AI config"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode managed AI config")
    }
}

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct ManagedAiConfigUpdate {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    /// Write-only. `None` retains the configured credential.
    pub api_key: Option<String>,
    /// Explicitly removes the credential. Cannot be combined with `api_key`.
    pub clear_api_key: bool,
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct ManagedAiStatus {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub api_key_configured: bool,
}

#[derive(Clone, Copy, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub enum ManagedAiRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct ManagedAiMessage {
    pub role: ManagedAiRole,
    pub content: String,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct ManagedAiRequest {
    pub project_id: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<ManagedAiMessage>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
}

/// Platform-managed model families an SME-owned canister may spend token
/// credits on. BYOK providers never use this API.
#[derive(Clone, Copy, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub enum ManagedAiService {
    IcLlm,
    DeepSeek,
}

/// Provider-neutral completion request used by agent canisters. Messages and
/// tools use `ic-rig`'s JSON representation so tool-call ids/results survive
/// the inter-canister hop without coupling Candid to one provider's schema.
#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct ManagedAiCompletionRequest {
    pub service: ManagedAiService,
    pub model: Option<String>,
    pub messages_json: String,
    pub tools_json: String,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub enum ManagedAiChoice {
    Message(String),
    ToolCallsJson(String),
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct ManagedAiCompletionResponse {
    pub choice: ManagedAiChoice,
    pub provider: String,
    pub model: String,
    pub usage: TokenUsage,
    pub usage_reported: bool,
    pub cumulative_usage: ManagedAiUsage,
    pub remaining_token_credits: u64,
    pub reserved_token_credits: u64,
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq, Eq)]
struct UsageCounters {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    successful_requests: u64,
    failed_requests: u64,
    last_used_at: u64,
}

impl Storable for UsageCounters {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes).expect("failed to encode managed AI usage");
        Cow::Owned(bytes)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode managed AI usage")
    }
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct UsageKey {
    owner: Principal,
    project_id: String,
    consumer: Principal,
}

impl Storable for UsageKey {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode managed AI usage key"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode managed AI usage key")
    }
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct ManagedAiUsage {
    pub owner: Principal,
    pub project_id: String,
    pub consumer: Principal,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub successful_requests: u64,
    pub failed_requests: u64,
    pub last_used_at: u64,
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct ManagedAiResponse {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub usage: TokenUsage,
    pub usage_reported: bool,
    pub cumulative_usage: ManagedAiUsage,
    pub remaining_token_credits: u64,
    /// Conservative pre-call ceiling used to reserve the provider request.
    pub reserved_token_credits: u64,
}

/// Platform billing account associated with a user/controller principal.
/// One credit currently represents one provider-reported token.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct SystemAccount {
    pub owner: Principal,
    pub token_credits: u64,
    pub reserved_token_credits: u64,
    pub lifetime_prompt_tokens: u64,
    pub lifetime_completion_tokens: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

impl Storable for SystemAccount {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes).expect("failed to encode system account");
        Cow::Owned(bytes)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode system account")
    }
}

/// The token-credit portion of an internal system account that is safe to
/// expose through the public Candid interface.
#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct TokenCreditBalance {
    pub balance: u64,
    pub reserved: u64,
    pub available: u64,
}

fn token_credit_balance(account: &SystemAccount) -> TokenCreditBalance {
    TokenCreditBalance {
        balance: account.token_credits,
        reserved: account.reserved_token_credits,
        available: account
            .token_credits
            .saturating_sub(account.reserved_token_credits),
    }
}

thread_local! {
    static CONFIG: RefCell<StableCell<ManagedAiConfig, Memory>> = RefCell::new(
        StableCell::init(
            super::MEMORY_MANAGER.with(|manager| manager.borrow().get(CONFIG_MEM_ID)),
            ManagedAiConfig::default(),
        )
    );

    static USAGE: RefCell<StableBTreeMap<UsageKey, UsageCounters, Memory>> = RefCell::new(
        StableBTreeMap::init(
            super::MEMORY_MANAGER.with(|manager| manager.borrow().get(USAGE_MEM_ID))
        )
    );

    static ACCOUNTS: RefCell<StableBTreeMap<Principal, SystemAccount, Memory>> = RefCell::new(
        StableBTreeMap::init(
            super::MEMORY_MANAGER.with(|manager| manager.borrow().get(ACCOUNTS_MEM_ID))
        )
    );

    // Transient by design: locks prevent duplicate in-flight charges, while a
    // canister upgrade naturally clears calls that can no longer resume.
    static PENDING: RefCell<BTreeSet<(Principal, String)>> = const { RefCell::new(BTreeSet::new()) };
}

struct CallerGuard {
    caller: Principal,
    project_id: String,
}

impl CallerGuard {
    fn acquire(caller: Principal, project_id: &str) -> Result<Self, String> {
        let key = (caller, project_id.to_string());
        PENDING.with(|pending| {
            if !pending.borrow_mut().insert(key) {
                return Err(
                    "a managed AI request is already running for this caller and project"
                        .to_string(),
                );
            }
            Ok(Self {
                caller,
                project_id: project_id.to_string(),
            })
        })
    }
}

impl Drop for CallerGuard {
    fn drop(&mut self) {
        PENDING.with(|pending| {
            pending
                .borrow_mut()
                .remove(&(self.caller, self.project_id.clone()));
        });
    }
}

#[derive(Clone)]
struct IcpClient;

impl HttpClient for IcpClient {
    type Error = HttpError;

    async fn post(&self, request: HttpRequest) -> Result<HttpResponse, Self::Error> {
        use ic_cdk_management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

        let args = HttpRequestArgs {
            url: request.url,
            method: HttpMethod::POST,
            headers: request
                .headers
                .into_iter()
                .map(|(name, value)| HttpHeader { name, value })
                .collect(),
            body: Some(request.body),
            // Includes response headers plus the JSON body. The generated text
            // itself is capped separately at MAX_OUTPUT_TOKENS.
            max_response_bytes: Some(131_072),
            transform: None,
            // LLM responses are non-deterministic and provider-billed. A
            // replicated POST would multiply the bill and fail consensus.
            is_replicated: Some(false),
        };

        let response = http_request(&args)
            .await
            .map_err(|error| HttpError(format!("{error:?}")))?;
        Ok(HttpResponse {
            status: response.status.0.try_into().unwrap_or(u16::MAX),
            body: response.body,
        })
    }
}

const MAINNET_LLM_CANISTER: &str = "w36hm-eqaaa-aaaal-qr76a-cai";
const CYCLES_PER_IC_LLM_CHAT: u128 = 100_000_000_000;

#[derive(Clone, Debug, CandidType, Deserialize)]
enum IcLlmChatMessage {
    #[serde(rename = "user")]
    User { content: String },
    #[serde(rename = "system")]
    System { content: String },
    #[serde(rename = "assistant")]
    Assistant(IcLlmAssistantMessage),
    #[serde(rename = "tool")]
    Tool {
        content: String,
        tool_call_id: String,
    },
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmAssistantMessage {
    content: Option<String>,
    tool_calls: Vec<IcLlmToolCall>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmResponse {
    message: IcLlmAssistantMessage,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmToolCall {
    id: String,
    function: IcLlmFunctionCall,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmFunctionCall {
    name: String,
    arguments: Vec<IcLlmToolCallArgument>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmToolCallArgument {
    name: String,
    value: String,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
enum IcLlmTool {
    #[serde(rename = "function")]
    Function(IcLlmFunction),
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmFunction {
    name: String,
    description: Option<String>,
    parameters: Option<IcLlmParameters>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmParameters {
    #[serde(rename = "type")]
    type_: String,
    properties: Option<Vec<IcLlmProperty>>,
    required: Option<Vec<String>>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcLlmProperty {
    #[serde(rename = "type")]
    type_: String,
    name: String,
    description: Option<String>,
    #[serde(rename = "enum")]
    enum_: Option<Vec<String>>,
}

#[derive(CandidType)]
struct IcLlmRequest {
    model: String,
    messages: Vec<IcLlmChatMessage>,
    tools: Option<Vec<IcLlmTool>>,
}

#[derive(Debug, thiserror::Error)]
enum IcLlmModelError {
    #[error("tool '{0}' has a schema unsupported by IC LLM")]
    UnsupportedToolSchema(String),
    #[error("IC LLM call failed: {0}")]
    Call(String),
    #[error("IC LLM returned neither text nor tool calls")]
    EmptyResponse,
}

struct BackendIcLlmModel {
    model: String,
}

impl CompletionModel for BackendIcLlmModel {
    type Error = IcLlmModelError;

    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<ic_rig::completion::CompletionResponse, Self::Error> {
        let tools = request
            .tools
            .into_iter()
            .map(convert_ic_llm_tool)
            .collect::<Result<Vec<_>, _>>()?;
        let canister = if ic_cdk::api::env_var_name_exists("PUBLIC_CANISTER_ID:llm") {
            Principal::from_text(ic_cdk::api::env_var_value("PUBLIC_CANISTER_ID:llm"))
                .map_err(|error| IcLlmModelError::Call(error.to_string()))?
        } else {
            Principal::from_text(MAINNET_LLM_CANISTER)
                .map_err(|error| IcLlmModelError::Call(error.to_string()))?
        };
        let response = ic_cdk::call::Call::bounded_wait(canister, "v1_chat")
            .change_timeout(300)
            .with_cycles(CYCLES_PER_IC_LLM_CHAT)
            .with_arg(IcLlmRequest {
                model: self.model.clone(),
                messages: convert_ic_llm_messages(request.messages),
                tools: (!tools.is_empty()).then_some(tools),
            })
            .await
            .map_err(|error| IcLlmModelError::Call(format!("{error:?}")))?
            .candid::<IcLlmResponse>()
            .map_err(|error| IcLlmModelError::Call(error.to_string()))?
            .message;

        let choice = if !response.tool_calls.is_empty() {
            ModelChoice::ToolCall(
                response
                    .tool_calls
                    .into_iter()
                    .map(convert_ic_llm_tool_call)
                    .collect(),
            )
        } else if let Some(text) = response.content {
            ModelChoice::Message(text)
        } else {
            return Err(IcLlmModelError::EmptyResponse);
        };
        Ok(ic_rig::completion::CompletionResponse {
            choice,
            reasoning: None,
            usage: None,
        })
    }
}

fn convert_ic_llm_messages(messages: Vec<Message>) -> Vec<IcLlmChatMessage> {
    let mut out = Vec::new();
    for message in messages {
        match message {
            Message::System { content } => out.push(IcLlmChatMessage::System { content }),
            Message::User { content } => {
                let mut text = Vec::new();
                for part in content {
                    match part {
                        UserContent::Text(value) => text.push(value.text),
                        UserContent::ToolResult(result) => {
                            if !text.is_empty() {
                                out.push(IcLlmChatMessage::User {
                                    content: std::mem::take(&mut text).join("\n\n"),
                                });
                            }
                            out.push(IcLlmChatMessage::Tool {
                                content: result.content,
                                tool_call_id: result.call_id,
                            });
                        }
                    }
                }
                if !text.is_empty() {
                    out.push(IcLlmChatMessage::User {
                        content: text.join("\n\n"),
                    });
                }
            }
            Message::Assistant { content } => {
                let mut text = None;
                let mut tool_calls = Vec::new();
                for part in content {
                    match part {
                        AssistantContent::Text(value) => text = Some(value.text),
                        AssistantContent::ToolCall(call) => {
                            tool_calls.push(convert_rig_tool_call(call));
                        }
                    }
                }
                out.push(IcLlmChatMessage::Assistant(IcLlmAssistantMessage {
                    content: text,
                    tool_calls,
                }));
            }
        }
    }
    out
}

fn convert_rig_tool_call(call: RigToolCall) -> IcLlmToolCall {
    let arguments = match call.arguments {
        serde_json::Value::Object(values) => values
            .into_iter()
            .map(|(name, value)| IcLlmToolCallArgument {
                name,
                value: json_value_to_wire_string(&value),
            })
            .collect(),
        value => vec![IcLlmToolCallArgument {
            name: "value".to_string(),
            value: json_value_to_wire_string(&value),
        }],
    };
    IcLlmToolCall {
        id: call.id,
        function: IcLlmFunctionCall {
            name: call.name,
            arguments,
        },
    }
}

fn convert_ic_llm_tool(definition: ToolDefinition) -> Result<IcLlmTool, IcLlmModelError> {
    let unsupported = || IcLlmModelError::UnsupportedToolSchema(definition.name.clone());
    let properties = definition
        .parameters
        .get("properties")
        .and_then(serde_json::Value::as_object);
    if properties.is_none()
        && definition
            .parameters
            .get("type")
            .and_then(serde_json::Value::as_str)
            != Some("object")
    {
        return Err(unsupported());
    }
    let required = definition
        .parameters
        .get("required")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let properties = properties
        .map(|properties| {
            properties
                .iter()
                .map(|(name, schema)| {
                    let type_ = schema
                        .get("type")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(&unsupported)?;
                    if !matches!(type_, "string" | "boolean" | "number" | "integer") {
                        return Err(unsupported());
                    }
                    Ok(IcLlmProperty {
                        type_: if type_ == "integer" {
                            "number".to_string()
                        } else {
                            type_.to_string()
                        },
                        name: name.clone(),
                        description: schema
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        enum_: schema
                            .get("enum")
                            .and_then(serde_json::Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            }),
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    Ok(IcLlmTool::Function(IcLlmFunction {
        name: definition.name,
        description: Some(definition.description),
        parameters: properties.map(|properties| IcLlmParameters {
            type_: "object".to_string(),
            properties: Some(properties),
            required: (!required.is_empty()).then_some(required),
        }),
    }))
}

fn convert_ic_llm_tool_call(call: IcLlmToolCall) -> RigToolCall {
    let arguments = call
        .function
        .arguments
        .into_iter()
        .map(|argument| (argument.name, wire_string_to_json_value(&argument.value)))
        .collect();
    RigToolCall {
        id: call.id,
        name: call.function.name,
        arguments: serde_json::Value::Object(arguments),
    }
}

fn json_value_to_wire_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        value => value.to_string(),
    }
}

fn wire_string_to_json_value(value: &str) -> serde_json::Value {
    serde_json::from_str(value).unwrap_or_else(|_| serde_json::Value::String(value.to_string()))
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        "openai" | "anthropic" | "gemini" | "deepseek" | "ic_llm" => Ok(()),
        _ => Err(
            "provider must be one of openai, anthropic, gemini, deepseek, or ic_llm".to_string(),
        ),
    }
}

fn status(config: &ManagedAiConfig) -> ManagedAiStatus {
    ManagedAiStatus {
        enabled: config.enabled,
        provider: config.provider.clone(),
        model: config.model.clone(),
        api_key_configured: !config.api_key.is_empty(),
    }
}

fn validate_request(request: &ManagedAiRequest) -> Result<(), String> {
    if request.project_id.is_empty() || request.project_id.len() > MAX_PROJECT_ID_BYTES {
        return Err("project_id must be between 1 and 128 bytes".to_string());
    }
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Err(format!(
            "messages must contain between 1 and {MAX_MESSAGES} entries"
        ));
    }
    if request
        .system_prompt
        .as_ref()
        .is_some_and(|prompt| prompt.len() > MAX_SYSTEM_PROMPT_BYTES)
    {
        return Err(format!(
            "system_prompt exceeds {MAX_SYSTEM_PROMPT_BYTES} bytes"
        ));
    }
    let mut total = request.system_prompt.as_ref().map_or(0, String::len);
    for message in &request.messages {
        if message.content.is_empty() || message.content.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "each message must contain between 1 and {MAX_MESSAGE_BYTES} bytes"
            ));
        }
        total = total.saturating_add(message.content.len());
    }
    if total > MAX_REQUEST_BYTES {
        return Err(format!("request text exceeds {MAX_REQUEST_BYTES} bytes"));
    }
    if request
        .max_output_tokens
        .is_some_and(|tokens| tokens == 0 || tokens > MAX_OUTPUT_TOKENS)
    {
        return Err(format!(
            "max_output_tokens must be between 1 and {MAX_OUTPUT_TOKENS}"
        ));
    }
    if request
        .temperature
        .is_some_and(|temperature| !temperature.is_finite() || !(0.0..=2.0).contains(&temperature))
    {
        return Err("temperature must be a finite number between 0 and 2".to_string());
    }
    Ok(())
}

fn completion_request_v2(
    request: &ManagedAiCompletionRequest,
) -> Result<CompletionRequest, String> {
    if request.messages_json.is_empty()
        || request
            .messages_json
            .len()
            .saturating_add(request.tools_json.len())
            > MAX_REQUEST_BYTES
    {
        return Err(format!(
            "serialized messages and tools must contain between 1 and {MAX_REQUEST_BYTES} bytes"
        ));
    }
    if request
        .model
        .as_ref()
        .is_some_and(|model| model.is_empty() || model.len() > MAX_MODEL_BYTES)
    {
        return Err(format!(
            "model must contain between 1 and {MAX_MODEL_BYTES} bytes"
        ));
    }
    if request
        .max_output_tokens
        .is_some_and(|tokens| tokens == 0 || tokens > MAX_OUTPUT_TOKENS)
    {
        return Err(format!(
            "max_output_tokens must be between 1 and {MAX_OUTPUT_TOKENS}"
        ));
    }
    if request
        .temperature
        .is_some_and(|temperature| !temperature.is_finite() || !(0.0..=2.0).contains(&temperature))
    {
        return Err("temperature must be a finite number between 0 and 2".to_string());
    }
    let messages: Vec<Message> = serde_json::from_str(&request.messages_json)
        .map_err(|error| format!("invalid managed AI messages: {error}"))?;
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err(format!(
            "messages must contain between 1 and {MAX_MESSAGES} entries"
        ));
    }
    let tools: Vec<ToolDefinition> = serde_json::from_str(&request.tools_json)
        .map_err(|error| format!("invalid managed AI tools: {error}"))?;
    if tools.len() > MAX_TOOLS {
        return Err(format!("at most {MAX_TOOLS} tools may be supplied"));
    }
    let mut completion = CompletionRequest::new(messages);
    completion.tools = tools;
    completion.max_tokens = Some(request.max_output_tokens.unwrap_or(1_024));
    completion.temperature = request.temperature;
    Ok(completion)
}

async fn resolve_project_system_account(
    project_id: &str,
    caller: Principal,
) -> Result<SystemAccount, String> {
    if caller == Principal::anonymous() {
        return Err("anonymous callers may not use managed AI".to_string());
    }
    let project = PROJECTS
        .with(|projects| projects.borrow().get(&project_id.to_string()))
        .ok_or_else(|| "project not found".to_string())?;

    // `canister_info` is the public management-canister method. Unlike
    // `canister_status`, it does not require this backend to control the
    // target and returns the target's certified controller set.
    let info = ic_cdk::management_canister::canister_info(
        &ic_cdk::management_canister::CanisterInfoArgs {
            canister_id: caller,
            num_requested_changes: Some(0),
        },
    )
    .await
    .map_err(|_| "managed AI may only be called by a canister".to_string())?;
    if !info.controllers.contains(&project.owner) {
        return Err("the project owner is not a controller of the calling canister".to_string());
    }
    ACCOUNTS
        .with(|accounts| accounts.borrow().get(&project.owner))
        .ok_or_else(|| "the calling canister's owner has no SystemAccount".to_string())
}

/// Resolves billing directly from the calling canister's certified
/// controllers. Exactly one controller must have a SystemAccount: none means
/// the canister has no funded owner, while more than one is ambiguous and is
/// rejected instead of charging an arbitrary account.
async fn resolve_controller_system_account(caller: Principal) -> Result<SystemAccount, String> {
    if caller == Principal::anonymous() {
        return Err("anonymous callers may not use managed AI".to_string());
    }
    let info = ic_cdk::management_canister::canister_info(
        &ic_cdk::management_canister::CanisterInfoArgs {
            canister_id: caller,
            num_requested_changes: Some(0),
        },
    )
    .await
    .map_err(|_| "managed AI may only be called by a canister".to_string())?;

    let matches = ACCOUNTS.with(|accounts| {
        let accounts = accounts.borrow();
        info.controllers
            .iter()
            .filter_map(|controller| accounts.get(controller))
            .collect::<Vec<_>>()
    });
    match matches.as_slice() {
        [] => Err("none of the calling canister's controllers has a SystemAccount".to_string()),
        [account] => Ok(account.clone()),
        _ => Err(
            "multiple calling-canister controllers have SystemAccounts; billing owner is ambiguous"
                .to_string(),
        ),
    }
}

/// Provider message framing also consumes input tokens. Counting every UTF-8
/// byte plus a fixed per-message envelope is deliberately conservative: it
/// is an upper bound for the BPE tokenizers used by the supported providers,
/// while an average `bytes / 4` estimate could authorize a call that later
/// costs more credits than the account owns.
fn input_token_ceiling(request: &ManagedAiRequest) -> u64 {
    let text_bytes = request.system_prompt.as_ref().map_or(0usize, String::len)
        + request
            .messages
            .iter()
            .map(|message| message.content.len())
            .sum::<usize>();
    (text_bytes as u64)
        .saturating_add((request.messages.len() as u64).saturating_mul(32))
        .saturating_add(256)
}

fn requested_credit_reservation(request: &ManagedAiRequest) -> u64 {
    input_token_ceiling(request)
        .saturating_add(u64::from(request.max_output_tokens.unwrap_or(1_024)))
}

fn requested_v2_credit_reservation(request: &ManagedAiCompletionRequest) -> u64 {
    (request
        .messages_json
        .len()
        .saturating_add(request.tools_json.len()) as u64)
        .saturating_add(256)
        .saturating_add(u64::from(request.max_output_tokens.unwrap_or(1_024)))
}

fn reserve_token_credits(owner: Principal, amount: u64) -> Result<(), String> {
    ACCOUNTS.with(|accounts| {
        let mut accounts = accounts.borrow_mut();
        let mut account = accounts
            .get(&owner)
            .ok_or_else(|| "SystemAccount not found".to_string())?;
        let available = account
            .token_credits
            .saturating_sub(account.reserved_token_credits);
        if available < amount {
            return Err(format!(
                "insufficient token credits: {available} available, {amount} required for the input and maximum output"
            ));
        }
        account.reserved_token_credits = account
            .reserved_token_credits
            .checked_add(amount)
            .ok_or_else(|| "token-credit reservation overflow".to_string())?;
        account.updated_at = ic_cdk::api::time();
        accounts.insert(owner, account);
        Ok(())
    })
}

fn release_token_credits(owner: Principal, amount: u64) {
    ACCOUNTS.with(|accounts| {
        let mut accounts = accounts.borrow_mut();
        if let Some(mut account) = accounts.get(&owner) {
            account.reserved_token_credits = account.reserved_token_credits.saturating_sub(amount);
            account.updated_at = ic_cdk::api::time();
            accounts.insert(owner, account);
        }
    });
}

fn settle_token_credits(
    owner: Principal,
    reserved: u64,
    usage: &TokenUsage,
    usage_reported: bool,
) -> Result<SystemAccount, String> {
    ACCOUNTS.with(|accounts| {
        let mut accounts = accounts.borrow_mut();
        let mut account = accounts
            .get(&owner)
            .ok_or_else(|| "SystemAccount disappeared while the request was running".to_string())?;
        account.reserved_token_credits = account.reserved_token_credits.saturating_sub(reserved);
        // A provider that omits usage must not become a free, unmetered path.
        // Charge the already-approved ceiling in that exceptional case.
        let charged = if usage_reported {
            usage.total_tokens
        } else {
            reserved
        };
        account.token_credits = account.token_credits.saturating_sub(charged);
        account.lifetime_prompt_tokens = account
            .lifetime_prompt_tokens
            .saturating_add(usage.prompt_tokens);
        account.lifetime_completion_tokens = account
            .lifetime_completion_tokens
            .saturating_add(usage.completion_tokens);
        account.updated_at = ic_cdk::api::time();
        accounts.insert(owner, account.clone());
        Ok(account)
    })
}

fn usage_record(key: &UsageKey, counters: UsageCounters) -> ManagedAiUsage {
    ManagedAiUsage {
        owner: key.owner,
        project_id: key.project_id.clone(),
        consumer: key.consumer,
        prompt_tokens: counters.prompt_tokens,
        completion_tokens: counters.completion_tokens,
        total_tokens: counters.total_tokens,
        successful_requests: counters.successful_requests,
        failed_requests: counters.failed_requests,
        last_used_at: counters.last_used_at,
    }
}

fn record_success(key: &UsageKey, usage: &TokenUsage) -> ManagedAiUsage {
    USAGE.with(|store| {
        let mut store = store.borrow_mut();
        let mut counters = store.get(key).unwrap_or_default();
        counters.prompt_tokens = counters.prompt_tokens.saturating_add(usage.prompt_tokens);
        counters.completion_tokens = counters
            .completion_tokens
            .saturating_add(usage.completion_tokens);
        counters.total_tokens = counters.total_tokens.saturating_add(usage.total_tokens);
        counters.successful_requests = counters.successful_requests.saturating_add(1);
        counters.last_used_at = ic_cdk::api::time();
        store.insert(key.clone(), counters.clone());
        usage_record(key, counters)
    })
}

fn record_failure(key: &UsageKey) {
    USAGE.with(|store| {
        let mut store = store.borrow_mut();
        let mut counters = store.get(key).unwrap_or_default();
        counters.failed_requests = counters.failed_requests.saturating_add(1);
        counters.last_used_at = ic_cdk::api::time();
        store.insert(key.clone(), counters);
    });
}

fn completion_request(request: &ManagedAiRequest) -> CompletionRequest {
    let mut messages =
        Vec::with_capacity(request.messages.len() + usize::from(request.system_prompt.is_some()));
    if let Some(system_prompt) = &request.system_prompt {
        messages.push(Message::system(system_prompt.clone()));
    }
    messages.extend(request.messages.iter().map(|message| match message.role {
        ManagedAiRole::User => Message::user(message.content.clone()),
        ManagedAiRole::Assistant => Message::assistant(message.content.clone()),
    }));
    let mut completion = CompletionRequest::new(messages);
    completion.max_tokens = Some(request.max_output_tokens.unwrap_or(1_024));
    completion.temperature = request.temperature;
    completion
}

async fn complete_with<M: CompletionModel>(
    model: M,
    request: CompletionRequest,
) -> Result<(String, TokenUsage, bool), String> {
    let response = model
        .complete(request)
        .await
        .map_err(|error| error.to_string())?;
    let text = match response.choice {
        ModelChoice::Message(text) => text,
        ModelChoice::ToolCall(_) => {
            return Err(
                "provider requested a tool, but managed AI completions do not expose tools"
                    .to_string(),
            )
        }
    };
    let usage_reported = response.usage.is_some();
    let usage = response.usage.map_or_else(TokenUsage::default, |usage| {
        let prompt_tokens = u64::from(usage.prompt_tokens);
        let completion_tokens = u64::from(usage.completion_tokens);
        TokenUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens.saturating_add(completion_tokens),
        }
    });
    Ok((text, usage, usage_reported))
}

async fn complete_v2_with<M: CompletionModel>(
    model: M,
    request: CompletionRequest,
) -> Result<(ManagedAiChoice, TokenUsage, bool), String> {
    let response = model
        .complete(request)
        .await
        .map_err(|error| error.to_string())?;
    let choice = match response.choice {
        ModelChoice::Message(text) => ManagedAiChoice::Message(text),
        ModelChoice::ToolCall(calls) => ManagedAiChoice::ToolCallsJson(
            serde_json::to_string(&calls)
                .map_err(|error| format!("failed to encode provider tool calls: {error}"))?,
        ),
    };
    let usage_reported = response.usage.is_some();
    let usage = response.usage.map_or_else(TokenUsage::default, |usage| {
        let prompt_tokens = u64::from(usage.prompt_tokens);
        let completion_tokens = u64::from(usage.completion_tokens);
        TokenUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens.saturating_add(completion_tokens),
        }
    });
    Ok((choice, usage, usage_reported))
}

async fn dispatch(
    config: &ManagedAiConfig,
    request: CompletionRequest,
) -> Result<(String, TokenUsage, bool), String> {
    match config.provider.as_str() {
        "openai" => {
            let client = ic_rig::providers::openai::Client::new(IcpClient, config.api_key.clone());
            complete_with(client.model(config.model.clone()), request).await
        }
        "anthropic" => {
            let client =
                ic_rig::providers::anthropic::Client::new(IcpClient, config.api_key.clone());
            complete_with(client.model(config.model.clone()), request).await
        }
        "gemini" => {
            let client = ic_rig::providers::gemini::Client::new(IcpClient, config.api_key.clone());
            complete_with(client.model(config.model.clone()), request).await
        }
        "deepseek" => {
            let client =
                ic_rig::providers::deepseek::Client::new(IcpClient, config.api_key.clone());
            complete_with(client.model(config.model.clone()), request).await
        }
        "ic_llm" => {
            complete_with(
                BackendIcLlmModel {
                    model: config.model.clone(),
                },
                request,
            )
            .await
        }
        _ => Err("managed AI provider is invalid".to_string()),
    }
}

async fn dispatch_v2(
    config: &ManagedAiConfig,
    service: ManagedAiService,
    model: String,
    request: CompletionRequest,
) -> Result<(ManagedAiChoice, TokenUsage, bool), String> {
    match service {
        ManagedAiService::IcLlm => complete_v2_with(BackendIcLlmModel { model }, request).await,
        ManagedAiService::DeepSeek => {
            if config.provider != "deepseek" || config.api_key.is_empty() {
                return Err("managed DeepSeek is not configured".to_string());
            }
            let client =
                ic_rig::providers::deepseek::Client::new(IcpClient, config.api_key.clone());
            complete_v2_with(client.model(model), request).await
        }
    }
}

/// Controller-only setup for the shared provider account. The credential is
/// intentionally never returned by any query.
#[ic_cdk::update]
fn configure_managed_ai(update: ManagedAiConfigUpdate) -> Result<ManagedAiStatus, String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may configure managed AI".to_string());
    }
    validate_provider(&update.provider)?;
    if update.model.is_empty() || update.model.len() > MAX_MODEL_BYTES {
        return Err(format!(
            "model must be between 1 and {MAX_MODEL_BYTES} bytes"
        ));
    }
    if update.clear_api_key && update.api_key.is_some() {
        return Err("api_key and clear_api_key cannot be supplied together".to_string());
    }
    if update
        .api_key
        .as_ref()
        .is_some_and(|api_key| api_key.is_empty() || api_key.len() > MAX_API_KEY_BYTES)
    {
        return Err(format!(
            "api_key must be between 1 and {MAX_API_KEY_BYTES} bytes"
        ));
    }

    CONFIG.with(|cell| {
        let mut cell = cell.borrow_mut();
        let mut config = cell.get().clone();
        config.enabled = update.enabled;
        config.provider = update.provider;
        config.model = update.model;
        if update.clear_api_key {
            config.api_key.clear();
        } else if let Some(api_key) = update.api_key {
            config.api_key = api_key;
        }
        if config.enabled && config.provider != "ic_llm" && config.api_key.is_empty() {
            return Err(
                "an API key must be configured before managed AI can be enabled".to_string(),
            );
        }
        cell.set(config.clone());
        Ok(status(&config))
    })
}

#[ic_cdk::query]
fn get_managed_ai_status() -> ManagedAiStatus {
    CONFIG.with(|config| status(config.borrow().get()))
}

/// Adds prepaid token credits after the platform's billing layer confirms a
/// purchase. Controller-only so callers cannot mint their own AI balance.
#[ic_cdk::update]
fn grant_token_credits(owner: Principal, amount: u64) -> Result<TokenCreditBalance, String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may grant token credits".to_string());
    }
    if owner == Principal::anonymous() {
        return Err("a SystemAccount owner cannot be anonymous".to_string());
    }
    if amount == 0 {
        return Err("token-credit grant must be greater than zero".to_string());
    }
    ACCOUNTS.with(|accounts| {
        let mut accounts = accounts.borrow_mut();
        let now = ic_cdk::api::time();
        let mut account = accounts.get(&owner).unwrap_or(SystemAccount {
            owner,
            token_credits: 0,
            reserved_token_credits: 0,
            lifetime_prompt_tokens: 0,
            lifetime_completion_tokens: 0,
            created_at: now,
            updated_at: now,
        });
        account.token_credits = account
            .token_credits
            .checked_add(amount)
            .ok_or_else(|| "token-credit balance overflow".to_string())?;
        account.updated_at = now;
        accounts.insert(owner, account.clone());
        Ok(token_credit_balance(&account))
    })
}

/// Owners can read their own token credits; backend controllers can inspect
/// any token-credit balance for billing and support.
#[ic_cdk::query]
fn get_token_credits(owner: Principal) -> Result<Option<TokenCreditBalance>, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller != owner && !ic_cdk::api::is_controller(&caller) {
        return Err("only the account owner or a controller may read token credits".to_string());
    }
    Ok(ACCOUNTS.with(|accounts| {
        accounts
            .borrow()
            .get(&owner)
            .map(|account| token_credit_balance(&account))
    }))
}

/// Calls the configured external provider and accounts for every token the
/// provider reports. Provider failures are also counted, without inventing a
/// token value when the provider supplied none.
#[ic_cdk::update]
async fn managed_ai_complete(request: ManagedAiRequest) -> Result<ManagedAiResponse, String> {
    validate_request(&request)?;
    let caller = ic_cdk::api::msg_caller();
    let _guard = CallerGuard::acquire(caller, &request.project_id)?;
    let account = resolve_project_system_account(&request.project_id, caller).await?;
    let config = CONFIG.with(|config| config.borrow().get().clone());
    if !config.enabled {
        return Err("managed AI is disabled".to_string());
    }
    if config.provider != "ic_llm" && config.api_key.is_empty() {
        return Err("managed AI has no provider credential configured".to_string());
    }

    let reserved_token_credits = requested_credit_reservation(&request);
    reserve_token_credits(account.owner, reserved_token_credits)?;

    let key = UsageKey {
        owner: account.owner,
        project_id: request.project_id.clone(),
        consumer: caller,
    };
    let completion = completion_request(&request);
    match dispatch(&config, completion).await {
        Ok((text, usage, usage_reported)) => {
            let account = settle_token_credits(
                account.owner,
                reserved_token_credits,
                &usage,
                usage_reported,
            )?;
            let cumulative_usage = record_success(&key, &usage);
            Ok(ManagedAiResponse {
                text,
                provider: config.provider,
                model: config.model,
                usage,
                usage_reported,
                cumulative_usage,
                remaining_token_credits: account
                    .token_credits
                    .saturating_sub(account.reserved_token_credits),
                reserved_token_credits,
            })
        }
        Err(error) => {
            release_token_credits(account.owner, reserved_token_credits);
            record_failure(&key);
            Err(format!("managed AI request failed: {error}"))
        }
    }
}

/// Provider-neutral managed completion endpoint for agent canisters. Unlike
/// the legacy text-only endpoint, this preserves tool calls so the agent's
/// normal `ic-rig` loop can execute its scoped business tools.
#[ic_cdk::update]
async fn managed_ai_completion(
    request: ManagedAiCompletionRequest,
) -> Result<ManagedAiCompletionResponse, String> {
    let completion = completion_request_v2(&request)?;
    let caller = ic_cdk::api::msg_caller();
    let _guard = CallerGuard::acquire(caller, "account")?;
    let account = resolve_controller_system_account(caller).await?;
    let config = CONFIG.with(|config| config.borrow().get().clone());
    if !config.enabled {
        return Err("managed AI is disabled".to_string());
    }

    let model = request
        .model
        .clone()
        .unwrap_or_else(|| match request.service {
            ManagedAiService::IcLlm => "llama3.1:8b".to_string(),
            ManagedAiService::DeepSeek if config.provider == "deepseek" => config.model.clone(),
            ManagedAiService::DeepSeek => ic_rig::providers::deepseek::DEEPSEEK_V4_PRO.to_string(),
        });
    if model.is_empty() || model.len() > MAX_MODEL_BYTES {
        return Err(format!(
            "model must contain between 1 and {MAX_MODEL_BYTES} bytes"
        ));
    }
    let provider = match request.service {
        ManagedAiService::IcLlm => "ic_llm",
        ManagedAiService::DeepSeek => "deepseek",
    }
    .to_string();
    let reserved_token_credits = requested_v2_credit_reservation(&request);
    reserve_token_credits(account.owner, reserved_token_credits)?;
    let key = UsageKey {
        owner: account.owner,
        // Kept empty in the legacy physical key layout. New agent usage is
        // account/consumer scoped and does not depend on a project.
        project_id: String::new(),
        consumer: caller,
    };

    match dispatch_v2(&config, request.service, model.clone(), completion).await {
        Ok((choice, usage, usage_reported)) => {
            let account = settle_token_credits(
                account.owner,
                reserved_token_credits,
                &usage,
                usage_reported,
            )?;
            let cumulative_usage = record_success(&key, &usage);
            Ok(ManagedAiCompletionResponse {
                choice,
                provider,
                model,
                usage,
                usage_reported,
                cumulative_usage,
                remaining_token_credits: account
                    .token_credits
                    .saturating_sub(account.reserved_token_credits),
                reserved_token_credits,
            })
        }
        Err(error) => {
            release_token_credits(account.owner, reserved_token_credits);
            record_failure(&key);
            Err(format!("managed AI request failed: {error}"))
        }
    }
}

/// Project owners can inspect their own breakdown. Controllers can inspect
/// every project for billing and support operations.
#[ic_cdk::query]
fn get_managed_ai_usage(project_id: String) -> Result<Vec<ManagedAiUsage>, String> {
    if project_id.is_empty() || project_id.len() > MAX_PROJECT_ID_BYTES {
        return Err("invalid project_id".to_string());
    }
    let caller = ic_cdk::api::msg_caller();
    let controller = ic_cdk::api::is_controller(&caller);
    let project = PROJECTS
        .with(|projects| projects.borrow().get(&project_id))
        .ok_or_else(|| "project not found".to_string())?;
    if caller != project.owner && !controller {
        return Err("only the project owner or a controller may read managed AI usage".to_string());
    }
    let mut rows = USAGE.with(|usage| {
        usage
            .borrow()
            .iter()
            .filter(|entry| entry.key().project_id == project_id)
            .map(|entry| usage_record(entry.key(), entry.value()))
            .collect::<Vec<_>>()
    });
    rows.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_request_limits() {
        let valid = ManagedAiRequest {
            project_id: "project-1".to_string(),
            system_prompt: Some("Be concise".to_string()),
            messages: vec![ManagedAiMessage {
                role: ManagedAiRole::User,
                content: "Hello".to_string(),
            }],
            max_output_tokens: Some(256),
            temperature: Some(0.2),
        };
        assert_eq!(validate_request(&valid), Ok(()));

        let mut invalid = valid.clone();
        invalid.max_output_tokens = Some(MAX_OUTPUT_TOKENS + 1);
        assert!(validate_request(&invalid)
            .unwrap_err()
            .contains("max_output_tokens"));

        let mut invalid = valid;
        invalid.temperature = Some(f64::NAN);
        assert!(validate_request(&invalid)
            .unwrap_err()
            .contains("temperature"));
    }

    #[test]
    fn v2_request_preserves_rig_messages_and_tools() {
        let messages = vec![Message::system("Be concise"), Message::user("Hello")];
        let tools = vec![ToolDefinition {
            name: "lookup_order".to_string(),
            description: "Look up an order".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        }];
        let request = ManagedAiCompletionRequest {
            service: ManagedAiService::DeepSeek,
            model: None,
            messages_json: serde_json::to_string(&messages).unwrap(),
            tools_json: serde_json::to_string(&tools).unwrap(),
            max_output_tokens: Some(256),
            temperature: Some(0.2),
        };
        let completion = completion_request_v2(&request).unwrap();
        assert_eq!(completion.messages, messages);
        assert_eq!(completion.tools.len(), 1);
        assert_eq!(completion.tools[0].name, "lookup_order");
    }

    #[test]
    fn status_never_exposes_the_api_key() {
        let config = ManagedAiConfig {
            enabled: true,
            provider: "openai".to_string(),
            model: "test-model".to_string(),
            api_key: "super-secret".to_string(),
        };
        assert_eq!(
            status(&config),
            ManagedAiStatus {
                enabled: true,
                provider: "openai".to_string(),
                model: "test-model".to_string(),
                api_key_configured: true,
            }
        );
    }
}
