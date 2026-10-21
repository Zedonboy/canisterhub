# connector

A two-way message gateway canister: it receives messages from several
outside services under one roof, and relays replies back out through
whichever one a message came from.

- **WhatsApp** - via the Cloud API's webhook (`GET`/`POST /webhook/whatsapp`)
  in, and a `POST .../messages` Graph API call out.
- **Telegram** - via the Bot API's webhook (`POST /webhook/telegram`) in, and
  a `sendMessage` Bot API call out.
- **Mail** - via `receive_mail` in (the same candid method
  [`mail_bridge`](../../services/mail_bridge/README.md) forwards inbound mail to), and a
  `POST <mail_bridge_url>/send_mail` call out.

Every inbound message ends up as a `StoredMessage` (see `src/messages.rs`),
queryable via `list_messages`/`get_message`. Sending a reply out is one
candid call - `send_message` - regardless of which channel it's going to.

Nothing here interprets message content - no NLP, no conversation state
machine, no LLM calls. This canister's whole job is protocol translation and
credential custody, so that whatever's actually having the conversation
(this project's `orchestrator`, or anything else) doesn't have to know each
service's webhook format, signing scheme, or send API.

## Configuration: one `Config` record

Every runtime parameter - channel secrets/tokens, and the two authorized
principals - lives in a single `Config` candid record (`src/config.rs`),
rather than one setter per field:

- **`init(Config)`** installs it at deploy time.
- **`update_config(ConfigUpdate) -> Result<(), String>`** (controller-only)
  applies a partial update. `ConfigUpdate` mirrors `Config` field-for-field,
  but each field is wrapped in one extra layer of `Option` beyond `Config`'s
  own, giving every field three states instead of two:
  - outer `None` (field omitted from the call): leave it untouched.
  - outer `Some(None)`: clear it to unset.
  - outer `Some(Some(value))`: set it to `value`.

  So a call only needs to name the field(s) it actually means to change -
  `ConfigUpdate { authorized_sender: Some(Some(principal)), ..Default::default() }`
  changes only `authorized_sender`, leaving everything else exactly as it
  was. `ConfigUpdate::default()` (every field `None`) is a no-op update.
- **`get_config() -> Result<Config, String>`** (controller-only) reads back
  the fully materialized `Config`, secrets included.

All fields are optional: a channel with unset fields simply can't be used
yet (its webhook returns `503`, `send_message` returns `Err` naming the
missing field) rather than the canister refusing to install without every
integration configured up front.

| Field | Used by |
|---|---|
| `mail_bridge_principal` | `receive_mail`'s caller check |
| `authorized_sender` | `send_message`'s caller check |
| `whatsapp_verify_token` | `GET /webhook/whatsapp`'s `hub.verify_token` check |
| `whatsapp_app_secret` | `POST /webhook/whatsapp`'s `X-Hub-Signature-256` check |
| `whatsapp_access_token` | `send_message`'s WhatsApp Cloud API call (Bearer token) |
| `whatsapp_phone_number_id` | `send_message`'s WhatsApp Cloud API call (URL path segment) |
| `telegram_secret_token` | `POST /webhook/telegram`'s `X-Telegram-Bot-Api-Secret-Token` check |
| `telegram_bot_token` | `send_message`'s Telegram `sendMessage` call |
| `mail_bridge_url` | `send_message`'s call to `<this>/send_mail` |
| `mail_bridge_api_key` | `send_message`'s mail call (Bearer token, matches `mail_bridge`'s `MAIL_BRIDGE_API_KEY`) |
| `mail_from_address` | `send_message`'s mail call (`From:` address) |
| `agent_canister` | Forwarded a normalized `{channel, session_id, text}` for every inbound message (see "Forwarding to an agent canister" below) - optional |

## Security model

Follows the `canister-security` skill's guidance for exactly this split:

- **HTTP endpoints have no caller identity** ("HTTP requests bypass the IC's
  authentication layer entirely") - trust is established cryptographically
  instead:
  - WhatsApp: `X-Hub-Signature-256` HMAC-SHA256, keyed by `whatsapp_app_secret`.
  - Telegram: `X-Telegram-Bot-Api-Secret-Token` header, compared to `telegram_secret_token`.
- **`receive_mail` and `send_message` are ordinary candid calls**, so they
  get full IC caller-identity guarantees: `receive_mail` is gated on
  `msg_caller()` matching `mail_bridge_principal`; `send_message` on it
  matching `authorized_sender`. A controller may always call either -
  useful for testing and manual intervention without impersonating the
  configured service's identity. `send_message` is gated at all because
  unrestricted access would let any caller spend this canister's configured
  WhatsApp/Telegram/mail_bridge credentials to send arbitrary messages.
- **`update_config`/`get_config` and every message-reading query are
  controller-only** - `Config` holds several secrets, and stored messages
  can carry personal data (phone numbers, email addresses, message text).

## `send_message`: replying out

```candid
type Channel = variant { WhatsApp; Telegram; Email };
type OutboundMessage = record {
  channel: Channel;
  session_id: text;
  text: text;
  subject: opt text;   // Email only; defaults to "Message"
};
send_message : (OutboundMessage) -> (variant { Ok; Err: text });
```

`session_id` is deliberately just "whatever address this channel uses"
rather than a separate conversation-id concept needing its own lookup table
- it's literally the same string already handed back on the matching
inbound message: `WhatsAppMessage.from`, `TelegramMessage.chat_id`
(stringified), or `MailMessage.envelope_from`.

Each channel's send is one HTTPS outcall (`src/outbound.rs`), made with
**`is_replicated: Some(false)`** rather than the subnet's usual
replicated-and-reconciled default. Sending a message is a real-world side
effect that should happen once; none of the WhatsApp Cloud API, Telegram Bot
API, or `mail_bridge`'s `/send_mail` offer a deduplication mechanism this
canister could rely on, so the default (every replica makes the call
independently) would visibly send the same message once per replica on the
subnet. The tradeoff accepted instead: a single unhealthy replica can make
one `send_message` call fail even though the rest of the subnet is fine -
surfaced as `Err` so a caller can decide whether to retry (which, like
retrying any non-idempotent API call, risks a second real delivery if the
first one actually landed).

## Forwarding to an agent canister

If `Config.agent_canister` is set, every inbound message that has text
content (a WhatsApp/Telegram message with `text`, or any mail) is forwarded
to it as `receive_message(record { channel; session_id; text })` -
normalized the same way regardless of source, so an agent canister (e.g.
this project's `agent`) doesn't need to know each channel's raw
payload shape. A message with no text (e.g. a WhatsApp image with no
caption) is not forwarded - there's nothing for an agent to reply to.

The forward is fire-and-forget (`ic_cdk::call::Call::oneway`, never
awaited): it happens *after* the message is already durably stored, and
must never affect the webhook's or `receive_mail`'s own response - a slow,
failing, or unconfigured agent is a secondary concern, and in
`receive_mail`'s case specifically, letting a forwarding hiccup surface as
an error would have `mail_bridge` read it as "delivery failed" and bounce
the mail over something wholly unrelated to whether the mail itself was
accepted.

## `http_request` / `http_request_update`

Both are part of the IC's HTTP Gateway protocol, not something this canister
invents: a boundary node calls `http_request` (a **query**) first, and if its
response sets `upgrade = opt true`, re-issues the identical request against
`http_request_update` (an **update** call, replicated through consensus) and
returns *that* response to the original HTTP client instead.

This canister uses that split for exactly what it's for: WhatsApp's `GET`
handshake is read-only, so `http_request` answers it directly; every webhook
`POST` needs to durably store a message, so `http_request` always upgrades
those instead of processing them itself - only `http_request_update` ever
touches stable storage.

## `llm_context`

```candid
llm_context : () -> (text) query;
```

Open to any caller - unlike `get_config`/`list_messages`, there's nothing
sensitive in a description of the canister's own shape, and an agent needs
to be able to read this *before* it has any credentials to call anything
else. Returns `src/llm_context.md`: a prose walkthrough of what this
canister does, every method's purpose and access control, `Config`'s
fields, and the non-obvious bits (which principal each gated method expects,
the single-replica outcall tradeoff, channel-specific quirks) - the
`service-discoverability` skill's `getApiDoc` pattern, named `llm_context`
per this project's own convention instead.

## Setup

1. Deploy with an initial `Config` (can be mostly-empty; fill in fields as
   you configure each channel):
   ```
   icp canister install connector --argument '(record {
     mail_bridge_principal = null;
     authorized_sender = opt principal "aaaaa-...";
     whatsapp_verify_token = opt "your-verify-token";
     whatsapp_app_secret = opt "your-app-secret";
     whatsapp_access_token = null;
     whatsapp_phone_number_id = null;
     telegram_secret_token = opt "your-telegram-secret";
     telegram_bot_token = null;
     mail_bridge_url = null;
     mail_bridge_api_key = null;
     mail_from_address = null;
   })'
   ```
2. As a controller, fill in the rest (or change anything later) with
   `update_config` - name only the field(s) you're changing, each wrapped in
   an extra `opt` (see "Configuration" above for the three-state semantics):
   ```
   icp canister call connector update_config '(record {
     whatsapp_access_token = opt opt "your-access-token";
     whatsapp_phone_number_id = opt opt "1234567890";
   })'
   ```
3. Point the upstream services at this canister's public URL:
   - WhatsApp: in the Meta developer console, set the webhook callback URL to
     `https://<canister-id>.icp0.io/webhook/whatsapp` and the verify token to
     `whatsapp_verify_token`. Meta calls it once (the `GET` handshake) to
     confirm, then starts POSTing.
   - Telegram: call `setWebhook` with `url` set to
     `https://<canister-id>.icp0.io/webhook/telegram` and `secret_token` set
     to `telegram_secret_token`.
   - Mail: point `mail_bridge`'s `RCPT TO` routing at this canister - see
     `services/mail_bridge/README.md`'s "Inbound routing".

## Reading messages back

```
icp canister call connector list_messages '(0, 20)'   # newest 20, controller-only
icp canister call connector get_message '(3)'          # controller-only
```

`MessagePayload` is a candid variant (`WhatsApp`/`Telegram`/`Mail`), each
carrying that channel's own shape - see `src/messages.rs` for the exact
fields. `MailMessage` is kept field-for-field identical to `mail_bridge`'s
own `IncomingMail` candid type by hand (candid matches record fields by name,
not by the two crates sharing a Rust type - if that struct's shape ever
changes there, this one needs updating to match).

## Regenerating `connector.did`

Hand-committed, not auto-generated at build time - `canister.yaml` points
`recipe.configuration.candid` at it directly. Regenerate it after changing
the candid surface (any `#[update]`/`#[query]`/`#[init]` signature, or a type
reachable from one):

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/connector.wasm > connector.did
```

## Testing

Unit tests (`cargo test --lib`) cover the pure logic: query-string/header
parsing, WhatsApp HMAC verification and payload parsing, Telegram secret
verification and `Update` parsing.

PocketIC integration tests (`tests/connector_tests.rs`) exercise the real
compiled canister end to end: `init`/`update_config`/`get_config`,
`receive_mail`/`send_message`'s caller-identity guards, controller-gating on
every query, the full webhook flow through `http_request`/
`http_request_update`, `send_message`'s HTTPS outcalls for all three
channels (mocked, following `backend/tests/marketplace_tests.rs`'s
mock-outcall pattern), and `llm_context`. Build the wasm first, then run
them - see `tests/connector_tests.rs`'s own doc comment for the exact
commands and the `POCKET_IC_BIN` env var.

## Limitations

- **WhatsApp**: only `messages[].type == "text"` is unpacked into `text` -
  every other type (image, audio, location, interactive replies, …) is still
  stored, with its full JSON in `raw`, but a caller wanting those fields
  structured has to parse `raw` itself. Delivery-status updates
  (`value.statuses[]` - sent/delivered/read receipts) are ignored entirely,
  not stored as messages. `send_message` only sends plain text replies (no
  media, templates, or interactive messages).
- **Telegram**: only message-like updates (`message`, `edited_message`,
  `channel_post`, `edited_channel_post`) are stored; anything else
  (`callback_query`, `my_chat_member`, inline queries, …) is acknowledged
  with `200` (so Telegram doesn't retry) but not stored.
- **No conversation/session state beyond `session_id` being an opaque
  routing address** - this canister does not track who's "in" a
  conversation, timeouts, or history beyond the raw `StoredMessage` log.
- **No outbound retry/backoff logic** - `send_message` makes one attempt and
  surfaces success or failure; retrying is the caller's decision (see
  "send_message: replying out" above for the single-replica-outcall
  tradeoff this implies).
- **No per-message delivery retries/acks beyond what each protocol already
  gives you** on the inbound side either - a stored message is stored once;
  there's no dedup against `WhatsAppMessage.message_id` if the Cloud API
  redelivers the same webhook (which its own retry policy can do).
