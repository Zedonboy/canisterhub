# agent

## What this canister is

`agent` is a **template**, not a finished product: a starting
point for an AI customer-support canister that a developer (or an AI agent,
given a business's requirements) adapts per business. It receives customer
messages forwarded by [`connector`](../connector), holds a conversation with
an LLM (either an HTTPS provider - OpenAI, Anthropic, Gemini, or DeepSeek,
via [`ic_rig`](https://github.com/Zedonboy/ic-rig) - or the real on-chain
LLM canister via [`ic_llm`](https://docs.rs/ic-llm); see "Choosing a
provider" below and `llm.rs`'s doc comment for the tradeoff) that can call a
small set of tools, and sends the reply back to the customer through
`connector` again.

**The one rule this whole template exists to enforce: the LLM can only ever
act on the current customer's own data, and can never perform anything
administrative.** Every other design decision here (the tool signature, the
webhook boundary, the reentrancy lock) serves that rule. If you take
nothing else from this document, take this: when you add a tool, ask "could
a malicious or confused conversation make this affect someone other than
the customer currently talking, or do something a human should approve
first?" If yes, it does not belong in `tools.rs` - see "Escalating to a
human" below.

## Architecture, end to end

```
WhatsApp/Telegram/Email --> connector --> agent --> connector --> WhatsApp/Telegram/Email
                                              |
                                              v
                          LLM: HTTPS provider outcall, or on-chain "platform"
                                       (tool-calling loop)
                                              |
                                    +---------+----------+
                                    |                     |
                          ordinary customer tool   request_admin_action
                          (local, immediate,        (files a request,
                           this customer only)       webhook notifies
                                                      an external system)
                                                              |
                                                              v
                                                   human/admin system decides,
                                                   calls back POST /webhook/admin
                                                              |
                                                              v
                                                 agent relays the
                                                 result to the customer via
                                                 connector - no LLM involved
```

1. `connector` calls `receive_message(IncomingMessage { channel, session_id, text })`.
   Only the principal in `Config.connector_principal` (or a controller) may
   call this.
2. `lib.rs::receive_message` acquires a per-conversation lock (`SessionGuard`),
   loads that conversation's stored history, and calls `llm::run_agent_loop`.
3. `run_agent_loop` picks a provider/model from `Config`, builds an
   `ic_rig::Agent` with this conversation's tools attached (see "The tool-
   calling loop" below), and calls `agent.chat(prompt, history)` -
   `ic_rig::Agent::chat` already implements the full completion <-> tool-
   dispatch loop internally (an HTTPS outcall to the provider's API each
   round, executing any tool calls, feeding results back, repeating) up to
   `Config.max_tool_iterations` times, returning the model's final text
   reply once it stops calling tools.
4. The finished `(User, Assistant)` turn is appended to that conversation's
   persisted history (trimmed to the last `state::MAX_HISTORY_MESSAGES`
   entries) and the assistant's reply is sent back to the customer via
   `connector::send_message`.
5. If, during step 3, the model called `request_admin_action`, that call
   filed an `AdminRequest` and POSTed it to `Config.admin_webhook_url`
   instead of doing anything itself. Whenever that external system later
   calls back `POST /webhook/admin` with a resolution, this canister relays
   the resolution text to the customer directly - independent of step 3,
   without going through the LLM again.

## The tool-calling loop, and the two kinds of "tool"

Every tool the model can call is a struct implementing `ic_rig::Tool`
(`NAME`, `Args`, `Output`, `definition()`, `call()`), registered in
`llm::run_agent_loop`'s `Agent::builder(..).tool(..)` chain. There are
exactly two categories, and the difference between them is the whole
security model:

**Ordinary customer tools** (`GetProfileTool`, `UpdateUsernameTool` in this
template) hold a `customer: SessionKey` field, set once by
`llm::run_agent_loop` from the caller's own context when it builds the
`Agent` for this turn. **`SessionKey` is never taken from the model's
tool-call arguments** - no example tool's `Args` type, or the JSON Schema
its `definition()` declares, even has a field for one. This is enforced
structurally, not just by convention: `Tool::call(&self, args: Self::Args)`
has no parameter through which a customer identity could arrive except
`self.customer`, which the model never controls. A tool's `call()` method
reads/writes state scoped to that one `SessionKey` and returns a value that
becomes the next tool-result message the model sees.

**The one reserved escalation tool**, `RequestAdminActionTool` (`ic_rig`
tool name `request_admin_action`), is registered exactly like any other
tool - `ic_rig::Agent` doesn't need it special-cased, since `Tool::call` is
already `async` for every tool uniformly. Its parameters are `action_type`
and `details` - free text describing *what is wanted*, never anything that
*performs* it. Calling it does not run a privileged action; its `call()`
method delegates straight to `admin::file_and_notify`, which records an
`AdminRequest` (`Pending`) and notifies an external system over a signed
webhook. See "Escalating to a human" below.

## Escalating to a human (or another system)

`admin::file_and_notify` (called by `RequestAdminActionTool::call`, and by
`llm::run_agent_loop`'s own iteration-exhaustion fallback - see that
function's doc comment) is the only place this canister reaches outside
itself on the model's say-so, and it never does anything but *ask*:

1. It stores an `AdminRequest { id, channel, session_id, action_type, details, status: Pending, ... }`.
2. If `Config.admin_webhook_url` and `admin_webhook_secret` are set, it POSTs
   `{ request_id, channel, session_id, action_type, details, created_at }`
   to `<admin_webhook_url>/admin/requests`, with an `X-Signature: sha256=<hmac>`
   header (HMAC-SHA256 of the raw body, keyed by `admin_webhook_secret`) so
   the receiver can verify it really came from this canister. This outcall
   uses `is_replicated: Some(false)` (a single replica, not the whole
   subnet) for the same reason `connector::send_message` does - see that
   canister's README.md's explanation, which applies identically here: a
   real-world side effect (notifying a human) should happen once, not once
   per replica.
3. It immediately tells the model (and, from there, the customer) that the
   request was filed - regardless of whether the notification actually
   reached the external system, since the request is already durably
   recorded and a controller can inspect it via `list_admin_requests`/
   `get_admin_request` and re-notify out of band if needed.
4. Whatever is on the other end of that webhook - a support ticket queue, a
   human reviewer, a separate more-heavily-audited canister or service -
   decides what to actually do, entirely outside this canister's trust
   boundary. **This template does not implement that side.** It could be a
   Slack bot, a ticketing system's inbound-webhook feature, or another
   canister (see `admin_agent` in this project for a template of an
   administrative-actions canister that could be *the* thing on the other
   end of this webhook).
5. It calls back `POST /webhook/admin` with
   `{ request_id, status: "approved"|"rejected"|"completed", message }`,
   signed the same way. `admin::handle_callback` verifies the signature,
   updates the `AdminRequest`, and `lib.rs` relays `message` to the customer
   via `connector::send_message` - **verbatim, not re-run through the LLM**.
   That last part matters: feeding admin-originated text back into the same
   tool-calling loop customer messages go through would let *that* content
   trigger tool calls too, which would quietly erase the boundary this
   whole document is about. Don't change this without a very good reason.

If `admin_webhook_url` is unset, `request_admin_action` returns an error to
the model (which should then tell the customer it can't help with that
right now) rather than silently doing nothing - administrative escalation
being unconfigured is a deployment gap, not a reason to pretend the request
succeeded.

## Adapting this template for a specific business

This is the part an LLM implementing a real business's canister from this
template should actually do:

1. **Read `tools.rs` in full first.** Its module doc comment is the
   authoritative statement of the one invariant every new tool must
   preserve.
2. **Write a system prompt** (`Config.system_prompt`) that states, in plain
   language: what the assistant is for, what it can do (matching your
   tools' actual descriptions - don't let the prompt promise more than the
   tools deliver), and what it explicitly cannot do (anything
   administrative - tell it to use `request_admin_action` for those rather
   than refuse outright or guess). See "Writing a good system prompt" below.
3. **Replace `GetProfileTool`/`UpdateUsernameTool` with your own
   customer-scoped tools.** For each one: define an `Args` struct
   (`#[derive(serde::Deserialize)]`) with only the *inputs* the action
   needs - never anything identity-shaped (no customer id, account id,
   session id, channel, phone, or email field - see the
   `no_tool_parameter_looks_like_a_customer_identifier` test in `tools.rs`,
   which enforces exactly this and should keep passing after your changes);
   a struct holding `customer: SessionKey`; and implement `ic_rig::Tool`
   with a specific, honest `description()` (the model decides *when* to
   call a tool from this text) whose `call()` reads/writes state keyed by
   `self.customer` only. Register it in `llm::run_agent_loop`'s
   `.tool(..)` chain. (`QueryDatabaseTool`, like `RequestAdminActionTool`, is
   infrastructure rather than business logic - keep it as-is; point
   `Config.ic_sql_canister_id` at your database instead of replacing it.)
4. **Decide what counts as administrative for your business** and make sure
   every one of those paths goes through `request_admin_action` rather than
   a new tool of its own. Refunds, account deletion/suspension, disputes,
   anything touching money or another customer's data, anything
   irreversible - these are almost always administrative. If genuinely
   unsure, treat it as administrative; the cost of an unnecessary
   escalation is small, the cost of an LLM having a direct path to
   something it shouldn't is not.
5. **Stand up whatever receives the webhook.** `admin_agent` (a sibling
   template in this project) is one option: a canister exposing both
   direct candid methods (for a human operator's frontend) and its own
   LLM/tool-calling loop for administrative actions, with a signed HTTP
   endpoint that could accept exactly the payload `notify_admin_webhook`
   sends. It is not wired up to `agent` automatically - connecting
   them (or connecting to a ticketing system, Slack, email, etc. instead)
   is a deployment decision, not something this template assumes for you.
6. **Configure `Config`** (`init` at deploy time, `update_config` -
   field-by-field, see below - afterward): `connector_principal` (from your
   `connector` deployment), `system_prompt`, optionally `llm_model` and
   `max_tool_iterations`, and `admin_webhook_url`/`admin_webhook_secret` if
   you built the receiving side of step 5.

### Writing a good system prompt

The model only knows what it can and can't do from your tools' descriptions
and whatever you put in the system prompt - it has no other source of truth
about its own limitations. A good prompt:

- States plainly what the assistant is for (one or two sentences).
- Does **not** need to enumerate every tool (the model sees the tool schema
  separately) but should set expectations about scope ("you can help with
  your own account's X, Y, Z").
- Explicitly says it has no administrative ability and should use
  `request_admin_action` rather than refuse outright or improvise when a
  request is legitimate but outside its other tools - this is the single
  highest-leverage sentence in the prompt, since it's what turns "I can't
  help with that" (a dead end for the customer) into a filed, tracked
  request.
- Says what to do when it's unsure rather than leaving it to guess (usually:
  ask a clarifying question, or escalate).

## Configuration (`Config`)

All fields optional; `init` installs the whole record, `update_config`
changes individual fields (see below).

| Field | Meaning |
|---|---|
| `connector_principal : opt principal` | Who may call `receive_message` - `connector`'s own identity |
| `system_prompt : opt text` | See "Writing a good system prompt" above; falls back to a generic prompt (`llm::default_system_prompt`) if unset |
| `llm_provider : opt text` | `"openai"` (default), `"anthropic"`, `"gemini"`, `"deepseek"`, or `"platform"` - see "Choosing a provider" below |
| `llm_model : opt text` | Provider-specific model id (e.g. `"gpt-5.6-sol"`, `"claude-sonnet-5"`, or - for `"platform"` - `"llama3.1:8b"`) - defaults to that provider's flagship model if unset (`llm::default_model_for`) |
| `llm_api_key : opt text` | API key for an HTTPS `llm_provider` - **required** for those, **not used at all for `"platform"`**; `receive_message` escalates to `request_admin_action`-style handling if this is unset when it's needed |
| `max_tool_iterations : opt nat8` | LLM<->tool round trips before automatic escalation (default `llm::DEFAULT_MAX_TOOL_ITERATIONS`, currently 4) |
| `admin_webhook_url : opt text` | Base URL `request_admin_action` POSTs to; unset disables escalation entirely (see "Escalating to a human") |
| `admin_webhook_secret : opt text` | Shared HMAC-SHA256 key, used both to sign outbound notifications and verify inbound `POST /webhook/admin` callbacks |
| `ic_sql_canister_id : opt principal` | A deployed [`ic-sql`](../ic-sql) canister's id, if this deployment has a database `query_database` should read from - see "The database query tool" below |

## The database query tool

`query_database` (`tools.rs::QueryDatabaseTool`) runs a read-only `SELECT`
against whatever `ic-sql` instance `Config.ic_sql_canister_id` names - e.g.
"what's the status of order 123", answered from a real `orders` table rather
than something the model has to know or guess. It's registered in every
deployment of this template regardless of whether `ic_sql_canister_id` is
set; if it's unset, every call just fails with a clear error instead of the
tool not existing at all.

Deliberately **read-only**, unlike `ic-sql` itself (which also has an
`execute` endpoint for mutations, exposed on the Rust side as
`db::execute`): unlike `update_username`, there's no fixed "customer" column
in an arbitrary SQL schema this tool could scope a write to, so instead of
restricting *what* it can touch, it restricts *how* - the model can look
things up, never change them. If your business needs the *model* to write to
the database as part of a customer-scoped action, don't loosen this tool -
add a new one that calls `db::execute` from its own `call()`, scoped exactly
the way `update_username` scopes its own write.

## Choosing a provider

Two real families, picked via `llm_provider`:

- **An HTTPS provider** (`"openai"`, `"anthropic"`, `"gemini"`,
  `"deepseek"`) - this template makes its own HTTPS outcall directly to
  that provider's API (via `ic_rig` - see `llm.rs`'s doc comment), so it
  needs a real API key from whichever one you pick:

  | `llm_provider` | Default model (`llm::default_model_for`) | Get a key from |
  |---|---|---|
  | `"openai"` (default) | `GPT_5_6` (`"gpt-5.6-sol"`) | platform.openai.com |
  | `"anthropic"` | `CLAUDE_SONNET_5` | console.anthropic.com |
  | `"gemini"` | `GEMINI_3_1_PRO_PREVIEW` | Google AI Studio |
  | `"deepseek"` | `DEEPSEEK_V4_PRO` | platform.deepseek.com |

  Override `llm_model` with any of the constants in `ic_rig::providers::<provider>`
  (e.g. `ic_rig::providers::openai::GPT_4O_MINI` for a cheaper OpenAI model) -
  pass the string it maps to, since `Config.llm_model` is plain text, not a
  candid enum (this keeps the template from needing a new candid variant
  every time a provider ships a new model).

- **`"platform"`** - a plain inter-canister call to the real on-chain LLM
  canister (via [`ic_llm`](https://docs.rs/ic-llm)) - no API key, no HTTPS
  outcall. Defaults to `"llama3.1:8b"` (free); other real models include
  `"qwen3:32b"`/`"llama4-scout"`/`"qwen2.5:0.5b"` (also free) and
  `"gemma3:27b"`/`"z-ai:glm-5.2"` (paid, drawn from **this canister's own
  cycles balance** - `ic_llm` attaches 100B cycles to every call
  unconditionally, even for a free model, so this canister must hold at
  least that many or the call traps). Trades real model choice and the
  HTTPS providers' generous limits for zero external setup: only
  DFINITY's own hosted models, and that canister's own prompt-size/
  schema limits (see `llm.rs::IcLlmModel`'s own doc comment - in
  particular, a custom tool with an array- or object-typed parameter isn't
  representable in `"platform"` mode and fails with a clear error; every
  tool this template ships is unaffected since they're all flat strings).
  Works locally too - point a local project's own `llm` canister at a
  real Ollama-backed instance and `ic_llm` picks it up automatically via
  `icp deploy`'s `PUBLIC_CANISTER_ID:llm` injection, no code change needed.

An unrecognized `llm_provider` value is rejected with a clear error rather
than silently falling back.

`update_config` takes a `ConfigUpdate`, not a `Config`: every field is
wrapped in one extra `opt` beyond `Config`'s own, giving each field three
states - omitted (leave untouched), `opt null` (clear it), or `opt opt value`
(set it) - so a call only needs to name the field(s) it's actually
changing. Identical semantics to `connector`'s `ConfigUpdate`; see that
canister's README.md if you want the fuller explanation.

## Methods

- `receive_message(IncomingMessage) -> variant { Ok; Err: text }` (update) -
  see "Architecture, end to end" above. Gated on `Config.connector_principal`.
- `update_config(ConfigUpdate) -> variant { Ok; Err: text }` (update,
  controller-only).
- `get_config() -> variant { Ok: Config; Err: text }` (query,
  controller-only - `Config` holds secrets).
- `get_conversation(Channel, text) -> variant { Ok: ConversationState; Err: text }`
  (query, controller-only) - reads back one conversation's stored history.
- `get_admin_request(nat64) -> variant { Ok: opt AdminRequest; Err: text }`
  and `list_admin_requests(nat64, nat64) -> variant { Ok: vec AdminRequest; Err: text }`
  (query, controller-only) - by id, or newest-first paginated.
- `http_request`/`http_request_update` - the IC's HTTP Gateway interface;
  this canister's only endpoint is `POST /webhook/admin` (see "Escalating to
  a human"). Not meant to be called directly except by whatever system your
  webhook receiver is.
- `llm_context() -> text` (query, open to any caller) - this document.

## Testing this template

`tests/agent_tests.rs` (PocketIC) covers `Config`/`ConfigUpdate`
semantics, `receive_message`'s and the admin webhook's access control, the
webhook HMAC round trip (mocked outcall), and the reentrancy guard - plus,
thanks to `ic_rig`'s bring-your-own-HTTP-client design, a **real end-to-end
run of `llm::run_agent_loop`** with a mocked HTTPS outcall standing in for
the provider's API
(`receive_message_uses_the_llm_response_and_persists_it_even_if_the_reply_relay_fails`):
it submits a `receive_message` call, waits for the pending outcall, mocks a
canned OpenAI-format JSON response, and checks the mocked reply text
reaches persisted conversation history. This is real coverage of the
`ic_rig::Agent::chat` wiring - constructing the request, parsing the
response - without needing a live provider account or API key. It does
*not* cover a multi-round tool-calling exchange (only a single plain-text
reply); mocking that further is possible (see `admin_agent`'s equivalent
test, which does exercise a mocked tool call) but wasn't necessary to prove
the plumbing here. `tools.rs`'s own unit tests (in particular
`no_tool_parameter_looks_like_a_customer_identifier` and
`update_username_only_ever_touches_the_key_the_caller_supplied`) are what
actually exercise this template's core security invariant, independent of
any LLM response - keep them passing, and add the equivalent for every
tool you add.

## Limitations

- **No conversation-level rate limiting or abuse detection.** A customer
  (or anything speaking as one through `connector`) can drive the tool-
  calling loop as often as `connector` allows messages through - this
  template does not itself throttle.
- **Tool results are trusted verbatim by the next LLM call.** A tool
  handler's `Ok(text)` becomes model input; keep tool output limited to
  data the tool itself produced, not arbitrary customer-supplied text
  reflected back unsanitized, to avoid one turn's tool output being used as
  a prompt-injection vector for the next.
- **`request_admin_action`'s `action_type` is free text**, not a fixed
  enum - deliberately, since specific admin action categories are
  business-defined (see "Adapting this template" step 4). A production
  deployment's webhook receiver should validate/whitelist `action_type`
  values it's prepared to handle rather than trusting the model's choice of
  category label for anything beyond routing/display.
- **No built-in retry if `connector::send_message` fails** after a
  successful LLM turn - the turn is already persisted to history by that
  point, but the customer may not receive the reply. A production
  deployment may want a retry/dead-letter mechanism here.
