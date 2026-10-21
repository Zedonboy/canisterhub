# auth

A user/profile management and Web2 authentication canister. It owns the
registration/login flow, creates and updates users, issues opaque session
tokens, and verifies those tokens for application canisters.

It supports two ways to be "signed in" that both resolve to the same `Profile`:

- **Principal-native** - the free, standard IC pattern. `get_my_profile`/
  `update_my_profile` use the caller's own IC identity (`msg_caller()`)
  directly; the first `update_my_profile` call for a principal creates its
  profile.
- **OAuth 2.0** - "Sign in with Google"/GitHub/any other OAuth2-compliant
  provider. `begin_oauth` returns an authorize URL; the provider's redirect
  back to this canister's own `/oauth/<provider>/callback` HTTP endpoint
  exchanges the code for the user's real identity, finds or creates the
  matching profile, and issues a session token that a plain browser client
  (no IC identity at all) can use to read its profile back.

OAuth registration and login intentionally share one flow: the first verified
provider callback creates the user, while later callbacks for the same stable
provider identity log that user in. Both outcomes issue a fresh session token.

`link_current_principal` merges the two: an already-authenticated caller
holding a valid OAuth session token can attach that identity to their own
principal-based profile.

Application canisters validate a Candid or HTTP bearer session through
`authorize_session(token)`. It returns only
`Authorization { profile_id; principal }`, and returns `null` for an invalid or
expired token. `authorize_principal(principal)` remains available for explicitly
principal-native applications; the classic `app_api` template uses sessions.
When an application also needs the user's basic credentials, `resolve_session`
returns `ProfileClaims { profile_id; principal; display_name; email;
avatar_url }` for a valid bearer token. `resolve_principal` returns the same
shape, but only to controllers and canisters listed in `trusted_canisters`.

See `src/llm_context.md` for the full design (also readable on-chain via the
`llm_context()` candid method) and its documented security model/known
limitations.

## Configuration

Installation takes no configuration argument. The standard dynamic config
surface (`get_config_schema`/`get_config`/`set_config`) owns
`session_ttl_secs` and `frontend_redirect_url` and persists them in stable
memory. OAuth providers and the trusted-canister allowlist remain collections
managed by their dedicated controller APIs.

- **`set_oauth_provider(name, OAuthProviderConfig)`**/**`remove_oauth_provider(name)`**
  (controller-only) manage one provider's config directly.
- **`update_config(ConfigUpdate)`** (controller-only) patches the session TTL
  and frontend redirect, or replaces the complete trusted-canister allowlist.
- **`get_auth_config()`** (controller-only) reads everything back, including
  every provider's `client_secret`.

After deploying, register this canister's callback URL with your OAuth
provider as its redirect URI:
`https://<canister-id>.icp0.io/oauth/<provider-name>/callback` (try the
`*.raw.icp0.io` form instead if the provider's redirect-URI validation
rejects the `icp0.io` HTML-certification wrapper).

## Security model

See `src/llm_context.md`'s own "Security model" section for the full
reasoning - in short: anonymous-principal rejection on every caller-scoped
method, a single-use CSRF `state` token that (not the URL path) selects
which provider's config an OAuth callback trusts, minimal non-sensitive
authorization results for application canisters, bearer-token gating for
session claims, an explicit trusted-canister allowlist for principal claims,
and controller-only gating on administrative methods that expose full profile
data, provider credentials, or config.

## Regenerating `auth.did`

Hand-committed, not auto-generated at build time - `canister.yaml` points
`recipe.configuration.candid` at it directly. Regenerate it after changing
the candid surface (any `#[update]`/`#[query]`/`#[init]` signature, or a
type reachable from one):

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/auth.wasm > auth.did
```

## Testing

Unit tests (`cargo test --lib`) cover the pure logic: `Config`/`ConfigUpdate`'s
three-state semantics, the stable-storage indices (principal/OAuth-subject
lookup, session expiry, single-use pending states), and `oauth.rs`'s
URL-building/percent-encoding/subject-field-detection - everything that
doesn't itself need a real network call or a real deployed canister.

The actual OAuth token/userinfo HTTPS outcalls (`oauth::exchange_code`)
aren't exercised by any test here, the same way `connector`'s real
WhatsApp/Telegram/mail_bridge sends aren't - they need a real provider on
the other end. Verify those by actually deploying against a real OAuth
app's credentials and completing a real login.

## Adapting this template

- `Profile`'s fields (`display_name`, `email`, `avatar_url`) are a common
  minimum - add whatever else your app needs directly to `messages.rs`.
- This canister has no role/permission concept beyond controller-only vs.
  everyone else; a deployment needing roles (admin/member/etc.) should add
  that to the authorization contract and have other canisters check it via
  `authorize_principal`/`authorize_session`.
