//! Works around a real, verified limitation in how local models serve tool
//! calls through Ollama - not a bug in this codebase or in `rig`.
//!
//! Verified directly (raw `POST /api/chat` probes against a real local
//! Ollama server, bypassing `rig`/this crate entirely - see
//! `tests/marketplace_search_and_deploy_tests.rs`'s own doc comment on
//! `ollama_agent_finds_and_deploys_the_published_ic_sql_marketplace_item`
//! for the full writeup): a completion request whose history ends in a
//! `role: "user"` message reliably gets a real, structured tool call back
//! from Ollama (confirmed on both `qwen2.5-coder:7b` and `llama3.1:8b`) -
//! but the *same* request with the exact same tools, once the history's
//! last message is `role: "tool"` (a prior call's own result - exactly
//! what every second-and-later turn of a real tool-calling loop looks
//! like), reliably does *not*: the model narrates the intended call as
//! JSON text instead of actually invoking it, every time tried.
//!
//! `rig`'s own `Message`/`UserContent` model already treats a tool result
//! as "user-visible context" conceptually (see `UserContent::ToolResult`'s
//! own doc comment) - it's specifically the OpenAI-compatible wire
//! converter shared by the openai/deepseek/ollama family that renders it as
//! a wire-level `role: "tool"` message, matching what OpenAI's real API
//! wants. That conversion is internal to `rig` and not configurable per
//! provider, so this module works around it one layer down: at the HTTP
//! transport `rig` itself is built to accept a custom one for
//! (`ClientBuilder::http_client`), rewriting `role: "tool"` to
//! `role: "user"` (with a short prefix so the content still reads as an
//! answer to a question, not a demand) on every outgoing request to
//! Ollama - and nothing else. `qwen2.5-coder`/`llama3.1` reliably use real
//! tool calls once the tool result reaches them this way (verified the
//! same way as the bug itself - see the same test's doc comment).
//!
//! Wire an Ollama client through this with
//! `ollama::Client::builder().api_key(()).http_client(OllamaToolResultShim::new(reqwest::Client::new(), enabled)).build()`
//! (`http_client`, not `from_env()`'s default reqwest client) - the rest of
//! `run_agent`'s "ollama" branch is unaffected. `enabled` is
//! `Config::ollama_tool_result_shim` - **not every local model needs this**.
//! Verified directly (same method as the bug itself): the `qwen3`/`qwen3.5`
//! family handles a genuine `role: "tool"` message correctly on its own,
//! 3/3 across repeated tries - for a model confirmed to behave like that,
//! set `enabled: false` so its conversation history matches what it
//! actually received, rather than leaving an unneeded rewrite in place on
//! the assumption it's harmless (not verified either way for those models).

use bytes::Bytes;
use rig::http_client::{self, HttpClientExt, LazyBody, MultipartForm, Request, Response, StreamingResponse};
use serde_json::Value;
use std::future::Future;

/// A short, neutral prefix that turns a bare tool-result payload into
/// something that reads naturally as a `user` turn, rather than a demand -
/// models otherwise sometimes treat an unprefixed JSON blob as itself being
/// the next thing to act on.
const PREFIX: &str = "Tool result: ";

#[derive(Clone, Debug, Default)]
pub struct OllamaToolResultShim<H> {
    inner: H,
    enabled: bool,
}

impl<H> OllamaToolResultShim<H> {
    pub fn new(inner: H, enabled: bool) -> Self {
        Self { inner, enabled }
    }
}

impl<H: HttpClientExt> HttpClientExt for OllamaToolResultShim<H> {
    fn send<T, U>(&self, req: Request<T>) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        let (parts, body) = req.into_parts();
        let body = maybe_rewrite(body.into(), self.enabled);
        let req = Request::from_parts(parts, body);
        self.inner.send(req)
    }

    fn send_multipart<U>(&self, req: Request<MultipartForm>) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        // Never used by a chat-completions request - passed through as-is.
        self.inner.send_multipart(req)
    }

    fn send_streaming<T>(&self, req: Request<T>) -> impl Future<Output = http_client::Result<StreamingResponse>> + Send
    where
        T: Into<Bytes> + Send,
    {
        // `orchestrator` never streams a completion - passed through as-is
        // (and left un-rewritten: if that ever changes, this needs the same
        // treatment as `send` above).
        self.inner.send_streaming(req)
    }
}

/// The whole of `enabled`'s effect: rewrite when on, pass the body through
/// verbatim when off. Split out from `send` so this - the actual behavior
/// difference the config flag produces - is directly unit-testable without
/// a full `HttpClientExt` mock.
fn maybe_rewrite(body: Bytes, enabled: bool) -> Bytes {
    if !enabled {
        return body;
    }
    rewrite_tool_roles_to_user(&body).unwrap_or(body)
}

/// Rewrites every `{"role": "tool", "content": "..."}` entry in a chat
/// request body's `messages` array to `{"role": "user", "content": "Tool
/// result: ..."}`. Returns `None` (leaving the original body untouched) for
/// anything that isn't a JSON object with a `messages` array - an
/// embeddings request, a malformed body, or a body this version of the
/// wire format doesn't shape the way expected; passing it through
/// unmodified is always the safe fallback.
fn rewrite_tool_roles_to_user(body: &Bytes) -> Option<Bytes> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let messages = value.get_mut("messages")?.as_array_mut()?;

    let mut changed = false;
    for message in messages {
        let Some(object) = message.as_object_mut() else { continue };
        if object.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        object.insert("role".to_string(), Value::String("user".to_string()));
        if let Some(content) = object.get("content").and_then(Value::as_str).map(str::to_string) {
            object.insert("content".to_string(), Value::String(format!("{PREFIX}{content}")));
        }
        changed = true;
    }

    if !changed {
        return None;
    }
    serde_json::to_vec(&value).ok().map(Bytes::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_a_tool_message_to_user_with_a_prefix() {
        let body = Bytes::from(r#"{"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"tool","content":"{\"ok\":true}"}]}"#);
        let rewritten = rewrite_tool_roles_to_user(&body).expect("should rewrite");
        let value: Value = serde_json::from_slice(&rewritten).unwrap();
        let messages = value["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "u");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "Tool result: {\"ok\":true}");
    }

    #[test]
    fn leaves_a_body_with_no_tool_message_untouched() {
        let body = Bytes::from(r#"{"messages":[{"role":"user","content":"hi"}]}"#);
        assert!(rewrite_tool_roles_to_user(&body).is_none());
    }

    #[test]
    fn leaves_a_non_chat_body_untouched() {
        let body = Bytes::from(r#"{"input":"embed this"}"#);
        assert!(rewrite_tool_roles_to_user(&body).is_none());

        let not_json = Bytes::from_static(b"not json at all");
        assert!(rewrite_tool_roles_to_user(&not_json).is_none());
    }

    #[test]
    fn maybe_rewrite_disabled_leaves_a_tool_message_byte_for_byte_untouched() {
        let body = Bytes::from(r#"{"messages":[{"role":"tool","content":"a"}]}"#);
        assert_eq!(maybe_rewrite(body.clone(), false), body, "disabled must not even reserialize the JSON, let alone rewrite it");
    }

    #[test]
    fn maybe_rewrite_enabled_rewrites_a_tool_message() {
        let body = Bytes::from(r#"{"messages":[{"role":"tool","content":"a"}]}"#);
        let rewritten = maybe_rewrite(body.clone(), true);
        assert_ne!(rewritten, body);
        let value: Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(value["messages"][0]["role"], "user");
    }

    #[test]
    fn rewrites_every_tool_message_when_there_are_several() {
        let body = Bytes::from(r#"{"messages":[{"role":"tool","content":"a"},{"role":"tool","content":"b"}]}"#);
        let rewritten = rewrite_tool_roles_to_user(&body).unwrap();
        let value: Value = serde_json::from_slice(&rewritten).unwrap();
        let messages = value["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "Tool result: a");
        assert_eq!(messages[1]["content"], "Tool result: b");
    }
}
