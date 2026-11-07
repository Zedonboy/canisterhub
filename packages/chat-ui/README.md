# chat-ui

Two small React pages for the `agent` canister, built from one Vite project:

| Entry | Built file | Who | What |
|---|---|---|---|
| `index.html` | `dist/index.html` | the SME (dashboard iframe, like `table-browser`) | **Inbox** of every customer conversation, AI-created **Tickets** for human follow-up, channel filter + search, reply-as-yourself, and a private **Agent console** |
| `chat.html` | `dist/chat.html` | customers | The **web channel**: an installable **PWA** chat page. The customer must sign in with Internet Identity before they can chat; their principal is their conversation |

When the agent calls `request_client_data`, this page reads the caller's
pending request. Location requests show a consent-driven browser geolocation
button; other request types adapt the composer prompt and submit the value
against the request id so stale controls cannot answer newer requests.

Image links display inline: any http(s) URL that is the only thing on its
line (or that ends in an image extension) renders as an embedded image with
a link fallback, so agent replies quoting an inventory `image_url` show the
product photo without the model having to emit image markup.

Like `table-browser`, it is not deployed on its own. Its `dist/` is embedded
into the agent wasm (`include_dir!`): the inbox is served at `/inbox`, customer
chat at `/chat`, and their shared assets/PWA files at the canister root.

```sh
cd packages/chat-ui
npm install
npm run build        # tsc -b && vite build
```

`packages/build.sh` builds it before compiling the embedding canister.

Tickets are the agent's persisted administrative requests. Operators can open
the related conversation and mark a ticket handled. Filing a ticket also sends
a best-effort project Web Push through the protocol gateway; the optional
administrative webhook remains available for external workflows.

Mock mode: `npm run dev:mock` runs both pages against in-memory data (the
customer sign-in is faked, no II needed).

Local dev: `.env.local` with `VITE_AGENT_CANISTER_ID=<id>` and
`VITE_IC_NETWORK=local|ic`, then `npm run dev` (`/` is the inbox, `/chat.html`
the customer page).

## Identity

- **Inbox**: same scheme as `table-browser` - dashboard delegation when
  iframed (`lib/parentDelegation.ts`, protocol in `frontend/src/lib/moduleDelegation.ts`),
  else Internet Identity sign-in. All inbox methods are controller-only.
- **Customer page**: the customer's own Internet Identity (`lib/customerAuth.ts`),
  gated by a sign-in screen. It deliberately skips the dashboard delegation
  handshake, so an embedding third-party site can't be mistaken for the dashboard.

## PWA

`public/manifest.webmanifest`, `icon-*.png` and `sw.js` are copied to `dist/`
and must be served from the same directory as `chat.html` (HTTPS, which the
IC gateway provides). `sw.js` caches only the same-origin static shell
(network-first for the page, cache-first for hashed assets) and never touches
`/api/*` or cross-origin traffic, so chat data and II sign-in always hit the
network. It is registered in production builds only. The agent canister must
serve these extra files with correct content types (`application/manifest+json`,
`text/javascript`, `image/png`).

## Backend contract (implemented in `packages/agent`)

The UI's Candid mirror is `src/lib/candid/agentChat.ts`. The agent canister
implements all of this (`agent/src/lib.rs`, "SME inbox + web channel"), covered
by the `web_chat_*`, `operator_reply_*` and `sme_console_*` tests in
`agent/tests/agent_tests.rs`. Known limits: `web_send` rate limits (3s gap,
200/day per principal) live in heap state and reset on upgrade; the console
runs with the same customer-scoped tools as any other session, not extra
admin tools; `display_name` is not populated yet.

```candid
type Channel = variant { Email; WhatsApp; Telegram; Web };          // + Web
type Role    = variant { User; Assistant; Operator };               // + Operator
type ConversationSummary = record {
  channel : Channel; session_id : text; display_name : opt text;
  last_text : text; last_role : Role; last_at : nat64; message_count : nat64;
};
service : {
  // controller-only
  list_conversations : (offset : nat64, limit : nat64) -> (variant { Ok : vec ConversationSummary; Err : text }) query;
  operator_reply     : (Channel, session_id : text, text) -> (ResultUnit);
  console_message    : (text) -> (variant { Ok : text; Err : text });
  // any non-anonymous caller (the customer, signed in with Internet Identity)
  web_send     : (text, opt text) -> (ResultUnit);  // text, optional display name
  web_messages : (after : nat64) -> (variant { Ok : vec StoredChatMessage; Err : text }) query;
}
```

Behaviour the UI relies on:

- **`list_conversations`**: iterate `CONVERSATIONS`, newest `last_at` first.
  Exclude the console session. `display_name`: email subject / Telegram username.
- **`operator_reply`**: deliver via the conversation's own channel
  (`outbound::send`), then append a `Role::Operator` turn to its history. For
  `Web` there is nothing to deliver - recording the turn is the delivery.
  Without the history append the SME's replies would vanish from the transcript.
- **`console_message`**: run `llm::run_agent_loop` for the reserved
  `SessionKey { Web, "__sme_console__" }` (constants `CONSOLE_CHANNEL` /
  `CONSOLE_SESSION`), store both turns, return the reply, and do **not** call
  `outbound::reply_to_customer`. The SME's own turns are stored as `Role::User`.
  Consider giving this session the controller-level tools (`admin.rs`) that
  customer sessions must not have.
- **`web_send`**: reject the anonymous principal, then `process_message` with
  `Channel::Web` and `session_id = caller.to_text()` (never a client-supplied
  id), minus the outbound call (the reply is just stored). Still needs a text
  length cap (the UI caps at 2000) and per-principal rate limits. II
  principals are per-origin, so a customer is a different principal on a
  different frontend origin - serve the page from one stable origin. The
  per-session `SessionGuard` already handles double-submits.
- **`web_messages`**: reject anonymous; return `history[after..]` of the
  caller's own session only. There is no id argument, so one customer can
  never read another's chat. Inbox shows these sessions under the principal text.
- `get_conversation` stays as is, but make sure it's controller-gated now that
  `Web` transcripts exist; the customer page uses `web_messages` instead.
- `Channel::Web` also needs handling in every `match` on `Channel`
  (`MessagePayload::incoming`, `outbound::send`, `SessionKeyStorable`).
  Existing stable data stays decodable because variants are only appended.

`web_send` resolves only after the LLM turn finishes (the update call spans the
HTTPS outcall), so the page shows an optimistic message plus a typing
indicator and polls every 2s meanwhile; idle polling is 5s (inbox list 5s,
open thread 3s, paused while the tab is hidden).

## Dashboard embedding

The agent reports `/inbox` as an `Admin` entry from `get_links`, so the
dashboard's `CanisterViewData` iframe path opens it just like
`table-browser`. The delegation handshake is implemented in
`lib/parentDelegation.ts`.
