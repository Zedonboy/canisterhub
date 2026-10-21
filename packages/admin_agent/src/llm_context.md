# admin_agent

## What this canister is

`admin_agent` is a **template** for an administrative-actions canister -
the trusted counterpart to [`agent`](../agent). Where
`agent` goes to great lengths to keep an LLM from ever directly
performing anything privileged, this canister *is* the privileged side:
every action it exposes runs only for a caller who has already been
authenticated by the IC itself as an admin (`require_admin` - see "Security
model" below). Once past that gate, the same action is reachable two ways:
as a plain candid method a frontend calls directly, and as a tool an AI
assistant can call on that same admin's behalf through `chat`. Both paths
call the exact same underlying function.

This is a **simple sample**: two example actions (`issue_refund`,
`set_account_status`), both stubs that record what would happen rather than
actually moving money or touching a real account system. Replace them with
your own business's administrative operations - see "Adapting this
template" below.

## The two ways to call an action

```
Frontend (buttons/forms) ---> issue_refund(order_id, amount_cents, reason)  --\
                                                                                >--> tools::issue_refund (one implementation, logs itself)
Frontend (chat UI) -------> chat([...history]) -> LLM -> tool call --------/
```

1. **Directly**: a frontend calls `issue_refund`/`set_account_status`
   (or whatever actions you add) like any other candid update method.
2. **Through `chat`**: a frontend calls `chat(history, prompt)` with the
   prior conversation (`Vec<ChatTurn>` - this canister's own candid type;
   see `messages.rs`) and the new message. `llm::run_agent_loop` picks a
   provider/model from `Config`, builds an `ic_rig::Agent` with both example
   tools attached, and calls `agent.chat(prompt, history)` - `ic_rig`'s own
   `Agent::chat` already implements the completion <-> tool-dispatch loop
   internally (an HTTPS outcall to the provider's API each round). `chat`
   returns the *whole updated conversation* (`history` plus a `User` turn
   for `prompt` plus an `Assistant` turn for the reply). The frontend keeps
   that list and passes it back as `history` next time - **`chat` itself
   persists nothing**. That's a deliberate simplification for this sample;
   a deployment wanting server-side history could reuse the same
   `SessionKey`-keyed stable-storage pattern `agent` uses, keyed
   by admin principal instead of by customer channel/session.

Both paths are gated by the same `require_admin()` check, and both end up
calling the same function in `tools.rs` - there is exactly one
implementation of each action's logic and its audit-logging behavior, never
two to keep in sync.

## Security model

- **`require_admin`** (`lib.rs`) is the only gate in this canister, applied
  to every action method, `chat`, and `list_action_log`: the caller must be
  a controller, or a principal listed in `Config.admins`. There is no
  anonymous or unauthenticated path to anything here.
- **Why tools here can take a target identifier (an order id, a customer
  reference) when `agent`'s tools deliberately cannot** (see that
  canister's `tools.rs`): `agent`'s tools are reachable by an
  arbitrary, untrusted customer conversation, so they're restricted to
  acting on "whoever is talking" and nothing else. Here, the caller of
  `chat` is never an arbitrary customer - it's a real, IC-authenticated
  admin, checked by `require_admin` before the LLM is even invoked. The
  model is a convenience layer for someone who could take the same action
  through the direct candid method anyway; it has no more power than the
  admin operating it.
- **`update_config`/`get_config` are controller-only**, stricter than
  `require_admin` - an admin can use the actions and read the audit log,
  but changing who counts as an admin, the system prompt, or the model is a
  controller-level decision.
- **Every action is logged** (`state::log_action` - who, what, when),
  regardless of which of the two paths invoked it, because letting
  privileged operations happen is this canister's entire purpose and an
  audit trail is not optional for that. `list_action_log` (admin-gated, not
  just controller-gated - an admin should be able to see what's been done)
  reads it back, newest-first.

## Writing a good system prompt

Same principle as `agent`'s (see that canister's `llm_context.md`
for the fuller version): the model only knows what it should do from the
system prompt and the tool descriptions. For an internal admin assistant,
that usually means: state what staff role this is for, remind it to confirm
specifics (order id, amount, which customer) before acting if a request is
ambiguous rather than guessing, and ask it to summarize what it did after
each action so the human reading the chat has a plain-language record
alongside the structured one in `list_action_log`.

## Adapting this template for a specific business

1. **Read `tools.rs`'s module doc comment first** - it explains why giving
   tools a target identifier is fine here (unlike in `agent`) and
   the "one implementation, two call sites" shape every action should keep.
2. **Replace `issue_refund`/`set_account_status`** with your own
   administrative operations. For each one: write the actual logic as a
   plain function that takes typed arguments, returns `Result<String, String>`
   (or `String` if it can't fail), and calls
   `state::log_action(ic_cdk::api::msg_caller(), "your_action_name", "...")`
   before returning success. Add a direct candid method in `lib.rs` that
   just calls it behind `require_admin()?`. Define an `Args` struct
   (`#[derive(serde::Deserialize)]`) and implement `ic_rig::Tool` for a
   small marker struct (see `IssueRefundTool` for the shape) whose `call()`
   parses `args` (typed - `serde_json` deserializes them for you, unlike
   `ic_llm`'s flat string arguments) and calls the same function. Register
   it in `llm::run_agent_loop`'s `.tool(..)` chain.
3. **Wire the stubs up to something real**, if your action should actually
   do something rather than just record intent: this project's
   `icrc-ledger` skill for a real refund (an ICRC-1/2 transfer), or a call
   to whatever canister/service owns account state for a status change.
4. **Write a system prompt** (`Config.system_prompt`) per "Writing a good
   system prompt" above.
5. **Decide who's an admin** (`Config.admins`) and configure it via
   `update_config` (controller-only).
6. **Consider whether you're the receiving end of `agent`'s
   escalation webhook.** If a business runs both templates, `admin_agent`
   is a natural place to review and act on `agent`'s
   `request_admin_action` requests - but that wiring (an HTTP endpoint here
   that accepts `agent`'s signed notification, and a call back to
   its `POST /webhook/admin` once resolved) is not implemented in this
   simple sample and would need to be added.

## Configuration (`Config`)

| Field | Meaning |
|---|---|
| `admins : vec principal` | Who may call any gated method (a controller may always call them too) |
| `system_prompt : opt text` | See "Writing a good system prompt"; falls back to a generic prompt (`llm::default_system_prompt`) if unset |
| `llm_provider : opt text` | `"openai"` (default), `"anthropic"`, `"gemini"`, or `"deepseek"` - see "Choosing a provider" below |
| `llm_model : opt text` | Provider-specific model id - defaults to that provider's flagship model if unset (`llm::default_model_for`) |
| `llm_api_key : opt text` | API key for `llm_provider` - **required**; `chat` returns an error if this is unset |
| `max_tool_iterations : opt nat8` | LLM<->tool round trips per `chat` call before returning whatever it has (default `llm::DEFAULT_MAX_TOOL_ITERATIONS`, currently 4) |

`update_config` takes a `ConfigUpdate`: `admins` replaces the whole list
when set (no per-element add/remove); every other field has the same
three-state semantics as `connector`'s `ConfigUpdate` (omitted = untouched,
`opt null` = clear, `opt opt value` = set) - see that canister's README.md
for the fuller explanation.

## Choosing a provider

Like `agent`, this template calls a real LLM provider's API
directly over an HTTPS outcall (via `ic_rig`, not the IC's on-chain LLM
canister - see `llm.rs`'s doc comment), so it needs a real API key:

| `llm_provider` | Default model (`llm::default_model_for`) |
|---|---|
| `"openai"` (default) | `GPT_5_6` (`"gpt-5.6-sol"`) |
| `"anthropic"` | `CLAUDE_SONNET_5` |
| `"gemini"` | `GEMINI_3_1_PRO_PREVIEW` |
| `"deepseek"` | `DEEPSEEK_V4_PRO` |

Override `llm_model` with any constant from `ic_rig::providers::<provider>` -
pass the string it maps to, since `Config.llm_model` is plain text.

## Methods

- `issue_refund(text, nat64, text) -> variant { Ok: text; Err: text }`,
  `set_account_status(text, text) -> variant { Ok: text; Err: text }`
  (update, admin-gated) - the example actions; see "Adapting this template"
  to replace them with your own.
- `chat(vec ChatTurn, text) -> variant { Ok: vec ChatTurn; Err: text }`
  (update, admin-gated) - see "The two ways to call an action" above.
  `ChatTurn { role: variant { User; Assistant }; content: text }` is this
  canister's own candid type (`messages.rs`) - the system prompt is
  supplied internally, never part of `history`.
- `update_config(ConfigUpdate) -> variant { Ok; Err: text }` (update,
  controller-only), `get_config() -> variant { Ok: Config; Err: text }`
  (query, controller-only).
- `list_action_log(nat64, nat64) -> variant { Ok: vec ActionLogEntry; Err: text }`
  (query, admin-gated) - newest-first, paginated.
- `llm_context() -> text` (query, open to any caller) - this document.

## Testing this template

`src/tools.rs`'s unit tests cover argument validation (`validate_status`)
and each tool's declared JSON Schema directly - pure/synchronous checks, so
they run on a plain host target. The action functions themselves
(`issue_refund`, `set_account_status`) call `ic_cdk::api::msg_caller()`
(via `state::log_action`), which only works inside a real canister or
PocketIC execution - those, `require_admin`'s gating on every method, and
the audit log are covered by `tests/admin_agent_tests.rs` (PocketIC)
instead.

That same PocketIC suite also runs `chat`'s LLM/tool-calling loop **end to
end** with a mocked HTTPS outcall standing in for the provider's API -
`ic_rig`'s bring-your-own-HTTP-client design (see `llm.rs`'s doc comment)
makes this possible without a live provider account. Unlike
`agent`'s equivalent test, this one mocks a full two-round
exchange: the first mocked response has the model call `issue_refund`, the
second gives its final text reply - and the test asserts the tool call
actually landed in the audit log, attributed to whoever called `chat`
(`chat_dispatches_a_tool_call_from_the_mocked_response_and_logs_it`). That
test is the reference to copy when adding your own tool's mocked-response
test.
