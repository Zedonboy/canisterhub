use crate::messages::{AiCanister, AiContext, AiMethod, SessionKey};
use candid::Principal;
use ic_rig::{Tool, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_CONTEXT_BYTES: usize = 256 * 1024;
const MAX_METHODS: usize = 128;
const MAX_JSON_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct ContextDocument {
    #[serde(default)]
    description: String,
    #[serde(default, alias = "tools")]
    methods: Vec<ContextMethod>,
}

#[derive(Deserialize)]
struct ContextMethod {
    name: String,
    description: String,
    parameters: Value,
}

pub async fn discover(canister_id: Principal) -> Result<AiCanister, String> {
    let response = ic_cdk::call::Call::bounded_wait(canister_id, "llm_context")
        .await
        .map_err(|e| format!("{canister_id}.llm_context call failed: {e:?}"))?;
    let text: String = response
        .candid()
        .map_err(|e| format!("invalid llm_context response: {e}"))?;
    if text.len() > MAX_CONTEXT_BYTES {
        return Err(format!(
            "llm_context is too large (maximum {MAX_CONTEXT_BYTES} bytes)"
        ));
    }
    let document: ContextDocument = serde_json::from_str(&text)
        .map_err(|e| format!("llm_context must be JSON with a methods array: {e}"))?;
    if document.methods.is_empty() {
        return Err("llm_context does not declare any ai_* methods".to_string());
    }
    if document.methods.len() > MAX_METHODS {
        return Err(format!(
            "llm_context declares too many methods (maximum {MAX_METHODS})"
        ));
    }

    let mut methods = Vec::with_capacity(document.methods.len());
    for method in document.methods {
        if !valid_method_name(&method.name) {
            return Err(format!("invalid AI method '{}': names must start with ai_ and contain only ASCII letters, digits, or underscores", method.name));
        }
        if !method.parameters.is_object() {
            return Err(format!(
                "{} parameters must be a JSON Schema object",
                method.name
            ));
        }
        if methods.iter().any(|m: &AiMethod| m.name == method.name) {
            return Err(format!("duplicate AI method '{}'", method.name));
        }
        methods.push(AiMethod {
            name: method.name,
            description: method.description,
            parameters: method.parameters.to_string(),
        });
    }
    Ok(AiCanister {
        canister_id,
        description: document.description,
        methods,
    })
}

fn valid_method_name(name: &str) -> bool {
    name.starts_with("ai_")
        && name.len() <= 128
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RemoteToolError(String);

pub struct RemoteCanisterTool {
    pub customer: SessionKey,
    pub project_id: Option<String>,
    pub canisters: Vec<AiCanister>,
}

#[derive(Deserialize)]
pub struct RemoteCallArgs {
    canister_id: String,
    method: String,
    parameters: String,
}

#[derive(Serialize)]
pub struct RemoteCallOutput {
    canister_id: String,
    method: String,
    result: Value,
}

impl Tool for RemoteCanisterTool {
    const NAME: &'static str = "call_canister";
    type Error = RemoteToolError;
    type Args = RemoteCallArgs;
    type Output = RemoteCallOutput;

    fn definition(&self) -> ToolDefinition {
        let catalog: Vec<Value> = self.canisters.iter().flat_map(|c| c.methods.iter().map(move |m| {
            json!({
                "canister_id": c.canister_id.to_text(),
                "method": m.name,
                "description": m.description,
                "parameters": serde_json::from_str::<Value>(&m.parameters).unwrap_or_else(|_| json!({"type":"object"})),
            })
        })).collect();
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!("Call one registered canister AI method. Only use a canister_id/method pair from this catalog: {}", Value::Array(catalog)),
            parameters: json!({
                "type": "object",
                "properties": {
                    "canister_id": { "type": "string" },
                    "method": { "type": "string", "description": "An ai_* method from the catalog" },
                    "parameters": { "type": "string", "description": "A JSON object encoded as text, matching that method's schema" }
                },
                "required": ["canister_id", "method", "parameters"]
            }),
        }
    }

    async fn call(&self, args: RemoteCallArgs) -> Result<RemoteCallOutput, RemoteToolError> {
        let canister_id = Principal::from_text(&args.canister_id)
            .map_err(|e| RemoteToolError(format!("invalid canister_id: {e}")))?;
        let registered = self
            .canisters
            .iter()
            .find(|c| c.canister_id == canister_id)
            .ok_or_else(|| RemoteToolError("canister is not registered".to_string()))?;
        if !registered.methods.iter().any(|m| m.name == args.method) {
            return Err(RemoteToolError(format!(
                "method '{}' was not declared by this canister's llm_context",
                args.method
            )));
        }
        let json_parameters = args.parameters;
        let parsed_parameters: Value = serde_json::from_str(&json_parameters)
            .map_err(|e| RemoteToolError(format!("parameters must be valid JSON: {e}")))?;
        if !parsed_parameters.is_object() {
            return Err(RemoteToolError(
                "parameters must encode a JSON object".to_string(),
            ));
        }
        if json_parameters.len() > MAX_JSON_BYTES {
            return Err(RemoteToolError(format!(
                "parameters exceed {MAX_JSON_BYTES} bytes"
            )));
        }
        let context = AiContext {
            project_id: self.project_id.clone().unwrap_or_default(),
            agent_canister_id: ic_cdk::api::canister_self(),
            channel: self.customer.channel,
            session_id: self.customer.session_id.clone(),
        };
        let response = ic_cdk::call::Call::bounded_wait(canister_id, &args.method)
            .with_args(&(context, json_parameters))
            .await
            .map_err(|e| RemoteToolError(format!("canister call failed: {e:?}")))?;
        let result: Result<String, String> = response
            .candid()
            .map_err(|e| RemoteToolError(format!("invalid AI method response: {e}")))?;
        let text = result.map_err(RemoteToolError)?;
        if text.len() > MAX_JSON_BYTES {
            return Err(RemoteToolError(format!(
                "result exceeds {MAX_JSON_BYTES} bytes"
            )));
        }
        let result = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok(RemoteCallOutput {
            canister_id: args.canister_id,
            method: args.method,
            result,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ai_prefixed_method_names_are_accepted() {
        assert!(valid_method_name("ai_lookup_order"));
        assert!(!valid_method_name("lookup_order"));
        assert!(!valid_method_name("ai_bad-name"));
    }
}
