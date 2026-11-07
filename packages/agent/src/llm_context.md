# Fused agent and connector

This canister owns WhatsApp, Telegram, and mail ingress/egress, conversation
history, the configured LLM, administrative escalation, and dynamically
discovered business tools.

Controllers register business canisters through the dynamic configuration's
`connected_canisters` vector or the compatibility `add_canister(principal)`
method. The agent calls each new canister's `llm_context() -> text` method and
accepts a JSON document with `description` and `methods`. Every method name
must begin with `ai_`; its `parameters` value is JSON Schema.

All declared methods share this Candid ABI:

```candid
type AiContext = record {
  project_id : text;
  agent_canister_id : principal;
  channel : variant { WhatsApp; Telegram; Email; Web };
  session_id : text;
};

ai_method : (AiContext, text) -> (variant { Ok : text; Err : text });
```

The second argument and successful result are JSON text. This canister derives
and supplies `AiContext` from the active conversation. The LLM only supplies
the method-specific JSON parameters. Target canisters must verify the caller
is their configured agent, require `msg_caller() == context.agent_canister_id`, and scope
all work from `AiContext`; identity/account fields must not be accepted in the
JSON parameter.

The registry is controller-only (`add_canister`, `remove_canister`, and
`list_canisters`). Calls are bounded-wait and may fail or have an unknown
outcome; state-changing `ai_*` methods should therefore be idempotent or
accept a request identifier that can be queried later.

Configuration is controller-only. `receive_mail` additionally authenticates
the configured mail bridge, while public HTTP webhooks validate their channel
secret/signature because HTTP gateway requests carry no IC caller identity.
Conversation processing uses a per-session guard across await points.

The `send_message` update is available to controllers and only the project
inventory canister identified by `order_inventory.wasm` in project context.
It accepts a session id without a channel. The agent resolves the session to
its stored conversation channel, sends through that channel's configured
adapter, and records the message in the conversation. For the Web channel,
the message is appended to stored history for the client to poll.
