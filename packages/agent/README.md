# agent

A **template** for an AI customer-support canister: receives customer
messages forwarded by [`connector`](../connector), holds a conversation via
tool calling with either a real LLM provider's API (OpenAI, Anthropic,
Gemini, or DeepSeek - an HTTPS outcall via
[`ic_rig`](https://github.com/Zedonboy/ic-rig)) or the real on-chain LLM
canister (`llm_provider = "platform"`, via
[`ic_llm`](https://docs.rs/ic-llm) - no API key needed; see `src/llm.rs`'s
doc comment for the tradeoff), and sends the reply back through `connector`. Not meant to be
deployed as-is - see `src/llm_context.md` (also served live via the
`llm_context` candid method) for the full architecture and, most
importantly, how to adapt it for a specific business.

## The one thing to understand before changing anything

**Every tool the model can call directly is scoped to the current
customer's own data and cannot be administrative.** This is enforced by
`ic_rig::Tool::call`'s signature in `src/tools.rs` (a tool struct holds the
current customer's identity as a field set by the dispatcher, with no way
for the model's arguments to supply or override it) and by keeping every
genuinely administrative action behind one reserved tool,
`RequestAdminActionTool`, which never performs anything itself - it only
files a request and notifies an external system over a signed webhook
(`src/admin.rs`). Read `tools.rs`'s and `admin.rs`'s module doc comments in
full before adding or changing a tool.

## Quick tour

- `src/lib.rs` - candid surface: `receive_message` (called by `connector`),
  `http_request`/`http_request_update` (the admin webhook callback only),
  `update_config`/`get_config`, observability queries, `llm_context`.
- `src/config.rs` - `Config`/`ConfigUpdate`, identical pattern to
  `connector`'s (see that canister's README.md for the full three-state
  partial-update explanation).
- `src/llm.rs` - the LLM/tool-calling loop.
- `src/tools.rs` - **read this first.** The customer-scoped tool registry
  and the security invariant every tool must preserve.
- `src/db.rs` - inter-canister client for [`ic-sql`](../ic-sql) (the
  "prebuilt SQL database" `query_database` reads from, if
  `Config::ic_sql_canister_id` is set) - plain functions, reusable by any
  tool's own logic, not only `query_database`.
- `src/admin.rs` - the administrative escalation boundary: outbound
  webhook notification, inbound signed callback.
- `src/messages.rs` / `src/state.rs` / `src/http.rs` / `src/outbound.rs` -
  candid types, stable storage, the IC HTTP Gateway types, and relaying
  replies back through `connector`, respectively.
- `src/llm_context.md` - the full template documentation, also served at
  runtime via the `llm_context` candid method.

## Setup

1. Deploy `connector` first (see `../connector/README.md`) and note its
   canister id.
2. Deploy this canister with an initial `Config` (get an API key from
   whichever provider you pick - see `src/llm_context.md`'s "Choosing a
   provider"):
   ```
   icp canister install agent --argument '(record {
     connector_principal = opt principal "<connector-canister-id>";
     system_prompt = opt "You are a support assistant for Acme Corp. You can look up and update the current customer'\''s own profile. For refunds, account deletion, or anything else outside that, use request_admin_action rather than refusing.";
     llm_provider = opt "openai";
     llm_model = null;
     llm_api_key = opt "sk-...";
     max_tool_iterations = null;
     admin_webhook_url = opt "https://your-admin-system.example.com";
     admin_webhook_secret = opt "a-long-random-shared-secret";
     ic_sql_canister_id = null;
   })'
   ```
   Set `ic_sql_canister_id` to a deployed [`ic-sql`](../ic-sql) canister's id
   to enable `query_database` (read-only `SELECT`s a customer's question can
   be answered from); leave it `null` to skip that tool entirely (the model
   can still call it, but every call fails with a clear "no database is
   configured" error).
3. On `connector`, set `agent_canister` (or whatever forwarding
   configuration `connector` uses - see its README.md) to this canister's
   id, so inbound messages actually reach `receive_message`.
4. Build whatever receives `POST <admin_webhook_url>/admin/requests` and
   later calls back `POST <this-canister>/webhook/admin` - see
   `src/llm_context.md`'s "Escalating to a human" section for the exact
   payload shapes and signature scheme. `admin_agent` (a sibling template
   in this project) is one option for the receiving side.

## Adapting this for a real business

See `src/llm_context.md`'s "Adapting this template for a specific business"
section for the full step-by-step - in short: replace `get_profile`/
`update_username` with your own customer-scoped tools, write a system
prompt that's honest about scope and points at `request_admin_action` for
anything outside it, and decide what counts as administrative for your
business (when in doubt, treat it as administrative).

## Regenerating `agent.did`

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/agent.wasm > agent.did
```

## Testing

`cargo test --lib` covers the pure logic - in particular
`tools.rs`'s `no_tool_parameter_looks_like_a_customer_identifier` and
`update_username_only_ever_touches_the_key_the_caller_supplied`, which
exercise this template's core security invariant directly. PocketIC
integration tests (`tests/agent_tests.rs`) cover `Config`/
`ConfigUpdate`, access control, and the admin webhook's HMAC verification -
plus, thanks to `ic_rig`'s bring-your-own-HTTP-client design, a real
end-to-end run of `llm::run_agent_loop` with a **mocked** HTTPS outcall
standing in for the provider's API (no live provider account or API key
needed). See that test file's own doc comment for exactly what it does and
doesn't cover.
