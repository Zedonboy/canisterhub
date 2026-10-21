# app_api

A Rust canister template for a conventional authenticated application API. It
serves the same example resource through Candid and JSON-over-HTTP and asks the
`auth` package to authorize every protected request.

The example `Item` resource is intentionally small and replaceable. The useful
part of the template is the boundary around it: authentication, ownership,
bounded cross-canister calls, HTTP query-to-update upgrades, stable storage,
input limits, and consistent error responses.

## Authentication

- `auth` owns Web2 registration/login, user profiles, session issuance, and
  session expiry. The first successful OAuth sign-in registers a user; later
  sign-ins resolve the same provider identity to that existing user.
- Protected Candid methods take a `session_token` argument and validate it
  through `auth.authorize_session`.
- HTTP routes require `Authorization: Bearer <session-token>` and call
  `auth.authorize_session(token)` from `http_request_update`.
- Both auth methods return the minimal non-sensitive
  `Authorization { profile_id; principal }` shape. Profile email, OAuth links,
  and provider configuration never cross this boundary.

The auth canister is discovered lazily through `PUBLIC_CANISTER_ID:auth`.
Include canisters named `auth` and `app_api` in the same `icp.yaml` environment
and run a full `icp deploy` so icp-cli injects the current ID. A missing or
invalid ID is returned as `AuthUnavailable`, not hardcoded into the Wasm.

## Candid API

- `health()` — public query.
- `get_my_identity(session_token)` — authenticated update.
- `create_item(session_token, CreateItem)` — authenticated update.
- `list_my_items(session_token)` — authenticated update.
- `delete_item(session_token, id)` — authenticated update.
- `llm_context()` — customization guidance for an LLM.

Reads that require auth are updates because an ordinary query cannot make this
authorization inter-canister call. See [`app_api.did`](./app_api.did) for exact
wire types.

## HTTP API

Use a raw canister URL because this template does not certify dynamic HTTP
responses:

```text
https://<app-api-canister-id>.raw.icp0.io
```

Routes:

- `GET /health`
- `GET /api/me`
- `GET /api/items`
- `POST /api/items` with JSON `{ "name": "...", "payload": "..." }`
- `DELETE /api/items/<id>`

Example:

```sh
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  https://APP_API_CANISTER_ID.raw.icp0.io/api/items
```

All protected routes make `http_request` return `upgrade = true`. The gateway
then invokes `http_request_update`, where auth is checked under consensus before
state is read or changed.

## Customize

1. Replace `CreateItem`/`Item` in `src/lib.rs` with domain types.
2. Replace the stable operations in `src/state.rs`.
3. Update the Candid methods and the HTTP router together.
4. Keep session-token validation, bearer parsing, bounded auth calls, ownership
   checks, payload limits, and stable-memory bounds. Never accept a profile id
   supplied by the application client.
5. Update `src/llm_context.md` and regenerate `app_api.did` after changing the
   interface.

## Build and verify

```sh
cargo test --manifest-path packages/app_api/Cargo.toml
cargo build --manifest-path packages/app_api/Cargo.toml \
  --target wasm32-unknown-unknown --release
```

Regenerate the committed Candid file after changing endpoints:

```sh
candid-extractor packages/target/wasm32-unknown-unknown/release/app_api.wasm \
  > packages/app_api/app_api.did
```
