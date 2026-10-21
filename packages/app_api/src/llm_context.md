# app_api customization context

This canister is a secure starting point for a classic JSON/Candid API. Replace
the example `Item` domain type with the application's resources, but preserve
these architectural boundaries:

- Auth owns the complete Web2 identity lifecycle: registration/login, user
  profiles, opaque session issuance, and expiry. App API code must not create
  users or mint sessions.
- Every protected Candid endpoint takes an Auth-issued `session_token` and
  validates it by calling `auth.authorize_session` with a bounded
  inter-canister call.
- HTTP gateway callers authenticate with `Authorization: Bearer <OAuth session>`.
  Validate it through `auth.authorize_session`; never trust a user/profile id
  supplied by the request itself.
- `http_request` is a query and must not mutate or perform inter-canister calls.
  Protected routes return `upgrade = true`; all authorization and mutations
  happen in `http_request_update` under consensus.
- Keep input/body limits, per-profile quotas, stable-memory storage, and
  ownership filters. Return `NotFound` rather than revealing that another user
  owns a requested resource.
- The auth canister ID comes from `PUBLIC_CANISTER_ID:auth`, injected by a full
  `icp deploy` when both canisters are in the same environment. Do not hardcode
  environment-specific canister IDs.
- The HTTP API is intended for a raw canister hostname such as
  `https://<canister-id>.raw.icp0.io`; responses are not certified.

Current example routes:

- `GET /health` (public)
- `GET /api/me` (bearer session)
- `GET /api/items` (bearer session)
- `POST /api/items` with `{ "name": "...", "payload": "..." }`
- `DELETE /api/items/<id>`

Equivalent authenticated Candid methods are `get_my_identity`, `create_item`,
`list_my_items`, and `delete_item`. They are updates because checking auth
requires an inter-canister call. Their first argument is always the session
token; the returned `profile_id` from Auth is the ownership key.
