# admin_agent

A **template** for an administrative-actions canister - the trusted
counterpart to [`agent`](../agent). Every action is
gated on the caller being a real, IC-authenticated admin
(`Config.admins`, or a controller), and once past that gate is reachable
two ways: as an ordinary candid method a frontend calls directly, or as a
tool an AI assistant can call on that same admin's behalf via `chat` (an
HTTPS outcall to a real LLM provider's API - OpenAI, Anthropic, Gemini, or
DeepSeek - via [`ic_rig`](https://github.com/Zedonboy/ic-rig); see
`src/llm.rs`'s doc comment). Both paths call the exact same underlying
function - see `src/tools.rs`'s doc comment. A **simple sample**: two
example actions (`issue_refund`, `set_account_status`), both stubs - see
`src/llm_context.md` (also served live via the `llm_context` candid method)
for the full picture and how to adapt it.

## Quick tour

- `src/lib.rs` - candid surface: `issue_refund`/`set_account_status`
  (direct action methods), `chat` (LLM tool-calling), `update_config`/
  `get_config`, `list_action_log`, `llm_context`.
- `src/tools.rs` - **read this first.** Every action's logic, its dual
  candid-method/LLM-tool exposure, and why that's safe here (unlike in
  `agent`).
- `src/llm.rs` - the (stateless) LLM/tool-calling loop `chat` uses.
- `src/messages.rs` - `ChatTurn`, the candid-facing conversation-turn type
  `chat` uses (converted to/from `ic_rig::Message` internally).
- `src/config.rs` - `Config`/`ConfigUpdate`.
- `src/state.rs` - stable storage: `Config` and the audit log.
- `src/llm_context.md` - full template documentation, also served at
  runtime via `llm_context`.

## Setup

Get an API key from whichever provider you pick (see `src/llm_context.md`'s
"Choosing a provider"):

```
icp canister install admin_agent --argument '(record {
  admins = vec { principal "<an-admin-principal>" };
  system_prompt = null;
  llm_provider = opt "openai";
  llm_model = null;
  llm_api_key = opt "sk-...";
  max_tool_iterations = null;
})'
```

Change `admins` (or anything else) afterward with `update_config`
(controller-only) - see `src/llm_context.md`'s Configuration section for
the exact `ConfigUpdate` shape.

## Regenerating `admin_agent.did`

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/admin_agent.wasm > admin_agent.did
```

## Testing

`cargo test --lib` covers pure argument validation and each tool's JSON
Schema (`tools.rs`). PocketIC integration tests
(`tests/admin_agent_tests.rs`) cover `require_admin` gating on every
method, the action methods succeeding end to end (including the audit
log), `Config`/`ConfigUpdate` - and, thanks to `ic_rig`'s bring-your-own-
HTTP-client design, a real end-to-end `chat` call with a **mocked**
two-round HTTPS exchange: the model calls `issue_refund`, then gives a
final reply, and the test confirms the tool call actually landed in the
audit log. No live provider account or API key needed. See that test
file's own doc comment.
