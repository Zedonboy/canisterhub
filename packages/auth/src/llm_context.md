# auth

## What this canister is

`auth` is a **template** for user/profile management and authentication -
"this canister is in charge of user/profile management and authentication,
handle OAuth etc" is the exact brief it exists to satisfy. It supports two
independent ways for one real person to be "signed in", and lets them merge
into a single `Profile`:

1. **Principal-native** - the free, standard IC pattern. `get_my_profile`/
   `update_my_profile` use the caller's own `msg_caller()` (an Internet
   Identity principal, or any other real IC identity) directly. No
   separate login step; the first `update_my_profile` call for a given
   principal creates its `Profile`.
2. **OAuth 2.0** - for "Sign in with Google"/GitHub/any other OAuth2
   provider, for users who don't have (or don't want to use) an IC
   identity. `begin_oauth(provider, link)` returns a URL to redirect the
   browser to; the provider's own redirect back to this canister's
   `/oauth/<provider>/callback` HTTP endpoint exchanges the authorization
   code for the user's real identity at that provider, finds or creates
   the matching `Profile`, and issues an opaque session token.
   `get_profile_by_session(token)` reads a profile back with that token,
   the way a traditional web app's session cookie would.

For a Web2 application, Auth owns the whole identity boundary. The first
successful OAuth callback for a provider identity is registration; subsequent
callbacks are login. Each successful callback issues a new opaque session token.
Application canisters do not create users or mint sessions—they pass tokens to
`authorize_session` and use the returned `profile_id` as their ownership key.

`link_current_principal` connects the two paths: an already-authenticated
principal caller who also holds a valid session token from an OAuth login
can attach that OAuth identity to their existing profile, so one real
person doesn't end up with two disconnected accounts.

## Configuration

`Config` holds `providers` (a name -> `OAuthProviderConfig` map - `client_id`/
`client_secret`/`authorize_url`/`token_url`/`userinfo_url`/`redirect_uri`/
`scope`; entirely provider-agnostic, nothing Google- or GitHub-specific) plus
session/frontend settings (`session_ttl_secs`, `frontend_redirect_url`) and
`trusted_canisters`, the application-canister allowlist for principal claims.

- Installation takes no config argument. **`get_config_schema`**,
  **`get_config`**, and controller-only **`set_config`** expose the fixed
  `session_ttl_secs` and `frontend_redirect_url` runtime settings.
- **`set_oauth_provider(name, OAuthProviderConfig)`**/**`remove_oauth_provider(name)`**
  (controller-only) manage one provider's config directly - not folded into
  a single-struct `ConfigUpdate` the way `connector`'s channel settings are,
  since "replace provider X" and "remove provider X" are the only
  operations a collection like this needs.
- **`update_config(ConfigUpdate)`** (controller-only) patches
  `session_ttl_secs`/`frontend_redirect_url` and can replace the complete
  `trusted_canisters` allowlist. `None` leaves a field unchanged; the redirect
  URL's nested option additionally supports clearing it.
- **`get_auth_config()`** (controller-only) reads the full config back,
  including every provider's `client_secret` - see "Security model" below.

### Registering a provider with the provider itself

Whatever OAuth2 provider you use, register this canister's callback URL as
its **redirect URI** - after deploying, that's:

```
https://<canister-id>.icp0.io/oauth/<provider-name>/callback
```

(`<provider-name>` is whatever key you pick when calling
`set_oauth_provider` - it's only ever used as this canister's own
routing/lookup key, never sent to the provider itself.) Some providers'
redirect-URI validation rejects `icp0.io`'s HTML-certification wrapper for
non-browser-navigation requests; if the callback doesn't seem to be
reaching the canister, try `https://<canister-id>.raw.icp0.io/oauth/...`
instead.

## Security model

- Every principal-scoped method (`get_my_profile`, `update_my_profile`,
  `link_current_principal`, and `begin_oauth` when `link: true`) rejects
  the anonymous principal outright.
- `authorize_principal` and `authorize_session` are intentionally callable by
  application canisters. They expose only the minimal `Authorization` record,
  never private profile fields or provider configuration.
- `resolve_principal` returns basic `ProfileClaims` only when its caller is a
  controller or is listed in `Config::trusted_canisters`. This is the intended
  inter-canister path for name/email/avatar data.
- `resolve_session` returns the same basic claims when presented with a valid
  bearer session. Possession of that opaque token is the authority; callers
  must protect it like a password and avoid logging it.
- The OAuth callback's `state` parameter is a single-use CSRF token (see
  `begin_oauth`) - a callback naming an unknown or already-consumed `state`
  is rejected, and the `state` token's own stored provider (never the
  URL's provider path segment alone) is what selects which provider config
  the exchange actually uses.
- `client_secret` is kept in canister state the same way `connector`'s
  channel secrets are - `get_auth_config` is
  controller-gated to protect it. This is the same tradeoff every other
  building block in this project makes (canister memory is technically
  readable by node operators on a standard subnet) - a deployment with a
  stricter threat model should look at vetKD-based secret management
  instead.
- `list_profiles`, `get_profile`, `update_config`, `get_auth_config`,
  `set_oauth_provider`, and `remove_oauth_provider` are all controller-only.

### A known, undefended race

Two concurrent callbacks for the *same real external user* (e.g. two
browser tabs each completing their own `begin_oauth` flow for the same
provider account within moments of each other) could each find no existing
profile yet and each create one - two profiles for one real person. Each
individual `state` token is single-use (so *replaying* one callback can't
double-create), but that doesn't serialize two genuinely separate,
both-legitimate flows against each other. Closing that fully needs a lock
keyed by the provider/subject pair, which isn't known until after the very
network call such a lock would need to guard - left as a known limitation
of this template rather than a solved problem.

## Why no PKCE

PKCE (RFC 7636) protects *public* clients (a browser SPA or mobile app,
neither of which can keep a `client_secret` confidential) from a stolen
authorization code being redeemed by an attacker. This canister holds
`client_secret` itself and performs the token exchange itself,
canister-side - exactly the "confidential client" case PKCE exists to make
unnecessary. A provider that specifically requires PKCE regardless of
client type would need this template extended.

## Adapting this template

- Add real provider config via `set_oauth_provider` once deployed - no
  code changes needed for a standard OAuth2 provider.
- `Profile`'s fields (`display_name`, `email`, `avatar_url`) are a common
  minimum; a real deployment wanting more (phone number, preferences, a
  business-specific field) should extend `Profile`/`UpdateProfile` in
  `messages.rs` directly.
- Web2 application backends should pass session tokens to `authorize_session`.
  Principal-native building blocks may capture their original caller before
  any await and pass it to `authorize_principal`. Calling `get_my_profile`
  across canisters would identify the calling canister, not the original end
  user. This template has no role/permission concept beyond controller-only vs.
  everyone else; a deployment needing roles (e.g. "admin" vs. "member") should
  extend the minimal authorization result deliberately.

## Candid interface

See `auth.did` for the exact types. The shape a completed login/link
returns is always the real `Profile` record - never trust anything else
about "who is this" beyond what this canister itself confirms.
