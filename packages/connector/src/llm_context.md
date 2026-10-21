# connector

## What this canister is

`connector` is a two-way message gateway sitting between three outside
services - WhatsApp, Telegram, and email (via a companion off-chain service
called `mail_bridge`) - and whatever is driving conversations on the IC side
(this project's `orchestrator`, or any other canister/agent an operator
authorizes). It normalizes all three channels into one shape for both
directions:

- **Inbound**: a message arriving from any channel is stored as a
  `StoredMessage` - a `channel`-tagged record queryable by id or in a
  newest-first paginated list.
- **Outbound**: a caller wanting to reply sends one `OutboundMessage`
  (channel + a `session_id` addressing the recipient + text), and this
  canister makes the appropriate outside API call itself.

Nothing here interprets message content - no NLP, no conversation state
machine, no LLM calls. This canister's whole job is protocol translation and
credential custody: it knows how to authenticate WhatsApp/Telegram webhooks,
how to call their send APIs, and how to talk to `mail_bridge`, so that
whatever is having the actual conversation doesn't have to.

## Data model

`StoredMessage { id: nat64, received_at: nat64 (ns since epoch), payload: MessagePayload }`

`MessagePayload` is a variant, one arm per inbound channel:

- `WhatsApp(WhatsAppMessage)` - `message_id`, `from` (sender's WhatsApp
  number), `to` (the business number it arrived on, if the payload included
  it), `message_type` (`"text"`, `"image"`, …), `text` (only populated for
  `message_type == "text"`), `timestamp` (WhatsApp's own, as a string),
  `raw` (the full JSON of that one message object).
- `Telegram(TelegramMessage)` - `update_id`, `message_id`, `chat_id`,
  `from_user_id`, `from_username`, `text`, `date` (Telegram's own, unix
  seconds), `raw` (the full `Update` JSON).
- `Mail(MailMessage)` - field-for-field identical to `mail_bridge`'s own
  `IncomingMail` candid type: `envelope_from`, `envelope_to`, `from`, `to`,
  `subject`, `text_body`, `html_body`, `headers`, `received_at`, `spf`/
  `dkim`/`dmarc` (each an `AuthResult`: `Pass`/`Fail`/`SoftFail`/`Neutral`/
  `None`/`TempError`/`PermError`), `tls`.

`OutboundMessage { channel: Channel, session_id: text, text: text, subject: opt text }`
where `Channel` is `WhatsApp`/`Telegram`/`Email`. `session_id` is
deliberately just "whatever address this channel uses" rather than a
separate conversation-id concept requiring its own lookup table - it's
literally the same string a caller already received on the matching inbound
message: a WhatsApp message's `from`, a Telegram message's `chat_id`
(stringified - Telegram chat ids are signed integers, but this field is text
so all three channels share one type), or a mail message's `envelope_from`.
`subject` only matters for `Email` (mail needs one; WhatsApp/Telegram don't
have the concept) and defaults to `"Message"` if omitted.

## Methods

### `receive_mail(MailMessage) -> variant { Ok; Err : text }` (update)

Called by `mail_bridge` for every piece of inbound mail addressed to this
canister. Only the principal configured as `Config.mail_bridge_principal`
(or a controller) may call this - an anonymous or mismatched caller gets
`Err`. On success, stores the message and returns `Ok`.

### `send_message(OutboundMessage) -> variant { Ok; Err : text }` (update)

Relays a message out through the channel it names:

- `WhatsApp`: `POST`s to the WhatsApp Cloud API
  (`https://graph.facebook.com/<version>/<whatsapp_phone_number_id>/messages`),
  authenticated with `whatsapp_access_token` as a Bearer token, sending
  `{"messaging_product":"whatsapp","to":<session_id>,"type":"text","text":{"body":<text>}}`.
- `Telegram`: `POST`s to
  `https://api.telegram.org/bot<telegram_bot_token>/sendMessage` with
  `{"chat_id":<session_id as an integer>,"text":<text>}`.
- `Email`: `POST`s to `<mail_bridge_url>/send_mail`, authenticated with
  `mail_bridge_api_key` as a Bearer token, sending
  `{"from":<mail_from_address>,"to":[<session_id>],"subject":<subject or "Message">,"text_body":<text>}`.

Each of these is an HTTPS outcall made with `is_replicated: Some(false)` -
deliberately routed through a single replica rather than the subnet's usual
byte-identical-consensus-across-all-replicas default. The reason: sending a
message is a real-world side effect that should happen once. None of
WhatsApp's, Telegram's, or `mail_bridge`'s send endpoints offer a
deduplication mechanism this canister could rely on, so the default
replicated behavior would mean every `send_message` call visibly sends the
same message once per replica on the subnet. The tradeoff accepted instead:
a single unhealthy replica can make one `send_message` call fail even though
the rest of the subnet is fine - surfaced as `Err` so a caller can decide
whether to retry (which, like retrying any non-idempotent API call, risks a
second real delivery if the first one actually landed).

Only `Config.authorized_sender` (or a controller) may call this - an
anonymous or mismatched caller gets `Err`. This exists specifically so this
canister's configured credentials can't be used by an arbitrary caller to
send arbitrary messages through it.

### `http_request(HttpRequest) -> HttpResponse` (query) / `http_request_update(HttpRequest) -> HttpResponse` (update)

The IC's own HTTP Gateway interface, not something specific to this
canister: a boundary node calls `http_request` first; if its response sets
`upgrade = opt true`, the boundary node re-issues the identical request
against `http_request_update` instead and returns *that* response to the
original HTTP client. This canister uses that split deliberately: WhatsApp's
`GET /webhook/whatsapp` verification handshake is read-only and answered
directly from the query call; every webhook `POST`
(`/webhook/whatsapp`, `/webhook/telegram`) always upgrades, since only an
update call is replicated through consensus and storing a message is a
state mutation. Neither endpoint has a caller identity to check (HTTP
requests bypass the IC's authentication layer entirely) - trust is
cryptographic instead:

- WhatsApp `POST`s must carry a valid `X-Hub-Signature-256` header (an
  HMAC-SHA256 of the raw body, keyed by `Config.whatsapp_app_secret`,
  verified in constant time). The `GET` handshake's `hub.verify_token` query
  param is checked against `Config.whatsapp_verify_token` instead - a
  different secret, used only to authorize *subscribing* the webhook URL in
  Meta's console in the first place.
- Telegram `POST`s must carry `X-Telegram-Bot-Api-Secret-Token` matching
  `Config.telegram_secret_token`.

A request failing either check gets `401`; an unconfigured secret gets
`503`; any other path or method gets `404`.

### `update_config(ConfigUpdate) -> variant { Ok; Err : text }` (update, controller-only)

Applies a partial update to the configuration, field by field.
`ConfigUpdate` has the same fields as `Config`, but each is wrapped in one
extra `opt` beyond `Config`'s own - so every field has three states, not
two:

- field omitted / `null` (outer `None`): leave that field exactly as it is.
- `opt null` (outer `Some`, inner `None`): clear that field to unset.
- `opt opt value` (outer `Some`, inner `Some(value)`): set that field to
  `value`.

A call naming only the fields it means to change leaves every other field
untouched - e.g.
`update_config(record { authorized_sender = opt opt principal "..."  })`
changes only `authorized_sender`.

### `get_config() -> variant { Ok : Config; Err : text }` (query, controller-only)

Returns the current configuration, including secrets - controller-only since
it would otherwise leak `whatsapp_app_secret`, `telegram_secret_token`,
`whatsapp_access_token`, `telegram_bot_token`, and `mail_bridge_api_key`.

### `get_message(nat64) -> variant { Ok : opt StoredMessage; Err : text }` and `list_messages(nat64, nat64) -> variant { Ok : vec StoredMessage; Err : text }` (query, controller-only)

Read stored messages back - by id, or newest-first paginated via
`(offset, limit)`. Controller-only: stored messages can carry personal data
(phone numbers, email addresses, message text).

### `llm_context() -> text` (query, open to any caller)

Returns this document. Open access is deliberate: an agent needs to be able
to read this before it has any credentials to call anything else here.

## Configuration (`Config`, one record for everything)

All fields are `opt` - a channel with unset fields simply can't be used yet
(its webhook returns `503`, `send_message` returns `Err` naming the missing
field) rather than the canister refusing to install without every
integration configured up front.

| Field | Used by |
|---|---|
| `mail_bridge_principal : opt principal` | `receive_mail`'s caller check |
| `authorized_sender : opt principal` | `send_message`'s caller check |
| `whatsapp_verify_token : opt text` | `GET /webhook/whatsapp`'s `hub.verify_token` check |
| `whatsapp_app_secret : opt text` | `POST /webhook/whatsapp`'s `X-Hub-Signature-256` check |
| `whatsapp_access_token : opt text` | `send_message`'s WhatsApp Cloud API call (Bearer token) |
| `whatsapp_phone_number_id : opt text` | `send_message`'s WhatsApp Cloud API call (URL path segment) |
| `telegram_secret_token : opt text` | `POST /webhook/telegram`'s `X-Telegram-Bot-Api-Secret-Token` check |
| `telegram_bot_token : opt text` | `send_message`'s Telegram `sendMessage` call |
| `mail_bridge_url : opt text` | `send_message`'s call to `<this>/send_mail` |
| `mail_bridge_api_key : opt text` | `send_message`'s mail call (Bearer token, matches `mail_bridge`'s `MAIL_BRIDGE_API_KEY`) |
| `mail_from_address : opt text` | `send_message`'s mail call (`From:` address) |
| `agent_canister : opt principal` | Every inbound message with text content is forwarded here as `receive_message(record { channel; session_id; text })`, fire-and-forget - see "Forwarding to an agent canister" below |

`init` takes a `Config` directly, so a fresh deployment can be installed
already-configured; `update_config` (see above) changes individual fields
afterward.

## Forwarding to an agent canister

If `Config.agent_canister` is set, every inbound message with text content
is forwarded to it as `receive_message(record { channel; session_id; text })`
- the same normalized shape regardless of source (a WhatsApp message's
`from`, a Telegram message's `chat_id` stringified, or a mail message's
`envelope_from`, paired with its text - `text_body`, falling back to
`subject`, for mail). A message with no text (e.g. a WhatsApp image with no
caption) is not forwarded.

The forward is fire-and-forget (`Call::oneway`, never awaited) and happens
strictly after the message is already durably stored - a slow, failing, or
unconfigured `agent_canister` never affects the webhook's or `receive_mail`'s
own response. This matters especially for `receive_mail`: if a forwarding
failure surfaced as that method's own error, `mail_bridge` would read it as
"delivery failed" and bounce the mail over a completely unrelated downstream
hiccup.

## What this canister deliberately does not do

- No conversation/session state beyond `session_id` being an opaque routing
  address - it does not track who's "in" a conversation, timeouts, or
  history beyond the raw `StoredMessage` log.
- No message content interpretation, no LLM calls, no auto-replies.
- No outbound retry/backoff logic - `send_message` makes one attempt and
  surfaces success or failure; retrying is the caller's decision.
- No deduplication of redelivered inbound webhooks (e.g. if WhatsApp's own
  retry policy redelivers a webhook, it's stored again).
