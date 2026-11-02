# agent

`agent` is the single messaging and AI module. It receives WhatsApp and
Telegram webhooks, mail from `mail_bridge`, runs the configured LLM/tool loop,
stores conversations/messages, and sends replies through the same channel.
The former standalone `connector` package is no longer a workspace member.

The agent owns its data. Conversations, customer profiles, inbound messages,
administrative requests, statistics, configuration, and discovered tool
metadata are stored directly in this canister with `ic-stable-structures` and
survive upgrades; no external data canister is required.

The canister also serves the certified `chat-ui`. Its `get_links` query
advertises the SME inbox at `/inbox` as an `Admin` link and the customer web
chat at `/chat` as a `Public` link.

Controllers configure the canister with `Config`, test conversations through
`receive_message`, and attach business canisters through
the dynamic configuration's **Agentic Canisters** list (or the compatibility
`add_canister(principal)` method). Registration reads and validates each
target canister's `llm_context` before persisting it.

The install-time `Config` argument is optional. When it is omitted, the
canister installs with `Config::default()` and a controller can complete setup
through the dynamic configuration API.

The grouped dynamic-configuration surface exposes every runtime setting,
including AI, WhatsApp, Telegram, email, administrative escalation, project
integrations, and `connected_canisters`. Adding a connected canister discovers
its `ai_*` methods; removing it removes those tools from subsequent LLM turns.
Secret fields are write-only and never returned by `get_config`. Browser push
is routed through the CanisterHub protocol, so the agent no longer needs or
exposes a notification-canister principal.
The agent canister ID and the WhatsApp, Telegram, administrative callback, and
mail ingress endpoints remain read-only. The older controller-only
`get_runtime_config`/`update_config` methods remain available for compatibility.

## AI access

The SME owner chooses one of two access models in the dashboard:

- **Managed** — choose DeepSeek or one of the free IC LLM models. The agent calls the CanisterHub
  backend, which resolves the SME account from the agent's controllers,
  reserves token credits, forwards provider-neutral messages and tool
  definitions, and records usage. No provider key is stored in the agent.
- **Own API key** — Claude/Anthropic, DeepSeek, or OpenAI. The key remains in
  this SME-controlled canister and the agent calls that provider directly via
  a non-replicated HTTPS outcall.

The protocol principal defaults to the value compiled in `src/protocol.rs`, so
the SME does not have to configure it; dynamic config exposes that default for
visibility and an optional deployment override. For managed calls, the backend reads the calling canister's
controllers and charges the matching controller's account-level token-credit
balance; no project identifier is configured or sent.

## AI canister contract

`llm_context() -> text` must return JSON:

```json
{
  "description": "Order service",
  "methods": [{
    "name": "ai_lookup_order",
    "description": "Look up the current customer's order",
    "parameters": {
      "type": "object",
      "properties": { "order_id": { "type": "string" } },
      "required": ["order_id"]
    }
  }]
}
```

Every listed method must start with `ai_` and expose:

```candid
type AiContext = record {
  agent : principal;
  channel : variant { WhatsApp; Telegram; Email };
  session_id : text;
};

ai_lookup_order : (AiContext, text) -> (variant { Ok : text; Err : text });
```

The second argument and successful result are JSON text. The agent creates
`AiContext`; models cannot choose its identity fields. A target canister must
verify `msg_caller()` is its configured agent (and matches `context.agent`)
before any protected action, then scope work from the context instead of
accepting a customer/account identifier in JSON.

Build and test from `packages/`:

```sh
cargo check -p agent
cargo test -p agent --lib
cargo build --target wasm32-unknown-unknown --release -p agent
```
