# ICP Rust Recipe Example

This example demonstrates how to use the built-in `rust` recipe type to build Rust canisters.

## Overview

The `rust` recipe type provides a streamlined way to build Rust canisters using Cargo with the WASM target. This is one of the built-in recipe types provided by ICP-CLI for common canister development workflows.

## Configuration

The [`canister.yaml`](./canister.yaml) file configures a canister using the built-in `rust` recipe.

### Key Components

- **`type: "@dfinity/rust@<version>"`**: Uses the built-in Rust recipe type. See [available versions](https://github.com/dfinity/icp-cli-recipes/releases?q=rust&expanded=true).
- **`package`**: Specifies the Cargo package name to build (required)

## Project Structure

- [`Cargo.toml`](./Cargo.toml): Cargo project configuration with WASM target setup
- [`src/lib.rs`](./src/lib.rs): Rust canister implementation using ic-cdk
- [`.gitignore`](./.gitignore): Git ignore rules for Rust projects

## How It Works

1. ICP-CLI uses the built-in `rust` recipe resolver
2. The resolver generates build steps that:
   - Build the specified Cargo package with `--target wasm32-unknown-unknown --release`
   - Move the resulting WASM file to the output path
   - Inject metadata about the Cargo version used
3. The canister is built and ready for deployment

## Prerequisites

- Rust toolchain with WASM target support
- Install via: <https://rustup.rs/>
- Add WASM target: `rustup target add wasm32-unknown-unknown`

## Build Process

The recipe automatically:

1. Compiles the Rust code to WASM using Cargo
2. Extracts the WASM binary from the target directory
3. Renames it to match ICP-CLI's expected output format
4. Injects build metadata using ic-wasm

## Use Cases

- Standard Rust canister development
- Projects using ic-cdk for Internet Computer development
- Canisters that don't require custom build logic
- Multi-package Rust workspaces

## Testing

`tests/marketplace_tests.rs` runs the marketplace, GitHub-ownership
challenge-response, and vetKD access-control flows against a real
[PocketIC](https://github.com/dfinity/pocketic) server — not a stub. It
exercises HTTPS outcall mocking (for the GitHub verification step) and a
real `test_key_1` vetKD threshold-key subnet (for `get_encrypted_vetkey` /
`get_vetkey_verification_key`), so it's a genuine end-to-end check of
everything except the actual production `key_1` key and real network calls.

Build the canister Wasm first (tests load it via `include_bytes!`, so it
must already exist), then run the tests:

```bash
IC_ENV=local cargo build --target wasm32-unknown-unknown --release
export POCKET_IC_BIN=/path/to/pocket-ic   # optional — auto-downloaded if unset
IC_ENV=local cargo test
```

## API access tokens (JWT)

`services/orchestrator/` (the HTTP Orchestration Agent) authenticates its callers via
short-lived JWTs this canister issues, rather than trusting it with
delegations or private keys directly:

1. **Once, after deploying**, a controller calls `init_jwt_signing_key` to
   generate this canister's HS256 signing key (from `raw_rand`, stored in
   stable memory) and the orchestrator's own `DEPLOY_IDENTITY_PEM` identity
   (also a controller) fetches it via `get_jwt_signing_key` at startup.
2. **Per session**, a frontend caller who has authenticated with Internet
   Identity calls `issue_jwt` (an authenticated update call, so the canister
   sees their real principal) and gets back a token valid for one hour.
3. The frontend sends that token as `Authorization: Bearer <token>` on every
   request to the orchestrator's HTTP API, which verifies it locally (no
   further canister calls) and scopes jobs to the token's principal.

## Web Push

Web Push subscriptions and delivery are owned by the protocol backend. Project
owners enable browser notifications from Settings; authorized project modules
send notifications through `send_project_notification`, which verifies project
membership and delivers to the owner's saved browser subscriptions.

## Managed AI access

The backend can fund a shared external-model account for SME projects. It uses
`ic-rig` for OpenAI, Anthropic, Gemini, and DeepSeek request/response handling,
with a non-replicated IC HTTPS outcall so one logical completion produces one
provider request rather than one request per subnet replica.

- A controller configures the write-only provider credential with
  `configure_managed_ai`. Passing `api_key = null` keeps the current key;
  `clear_api_key = true` removes it.
- `managed_ai_complete` is the compatibility text-only endpoint and retains
  its project-scoped request shape for existing callers.
- `managed_ai_completion` is the tool-capable agent gateway. An agent chooses
  managed IC LLM or managed DeepSeek; messages, tool definitions, tool-call
  IDs, and tool results survive the inter-canister hop so its normal tool loop
  continues to work. It accepts only canister callers, reads the caller's
  certified controller set through `canister_info`, and charges the single
  controller that has a SystemAccount. No project ID is accepted. Provider
  credentials remain backend-only.
- `grant_token_credits` is the controller-only billing hook, while
  `get_token_credits` exposes only the owner's balance. Account metadata,
  lifetime usage, and reservation bookkeeping stay internal.
  Before an external request, the backend reserves enough credits for a
  conservative input-token ceiling plus the requested maximum output. It
  rejects insufficient balances before spending provider or outcall funds,
  then settles the reservation against provider-reported token usage.
- `get_managed_ai_usage` returns the provider-reported prompt, completion, and
  total tokens per calling principal, along with successful/failed request
  counts. These counters use stable memory and survive upgrades.
- Request text, message count, output tokens, and concurrent calls from the
  same consumer canister are bounded to limit accidental or hostile spending.

The API key is never returned through Candid, but standard application-subnet
canister memory is not a cryptographic secret from subnet node operators. For
deployments whose threat model excludes node operators, use a separate
provider-compatible metering proxy and add a corresponding `ic-rig` HTTP/model
adapter rather than placing the raw provider key in canister state.

## Production security checklist

- Set `IC_ENV=ic` for every mainnet build or deploy. `backend/build.rs`
  defaults to `local` when `IC_ENV` is unset and otherwise accepts only `ic`
  or `local`, then selects the vetKD master key at compile time:

  ```bash
  IC_ENV=local icp deploy backend
  IC_ENV=ic icp deploy -e ic backend
  ```

  An unset `IC_ENV` or explicit `IC_ENV=local` compiles `test_key_1`;
  `IC_ENV=ic` compiles production `key_1`. An unknown value fails the build.
  `IC_ENV` controls compilation only; `-e ic` is still required to tell
  icp-cli to deploy to mainnet.
  The KeyManager persists the selected key, so this is not an after-install
  rotation switch. Do not install a local build on mainnet first and expect a
  later `IC_ENV=ic` upgrade to change its existing key configuration.
- Keep the controller set minimal and use a controller policy suitable for
  production (for example, a governance or multisig canister rather than a
  personal hot identity).
- Initialize JWT signing once, then verify that the orchestrator can fetch the
  key with its controller identity. The current HS256 design deliberately
  trusts every backend controller with token-signing authority; migrate this
  boundary to asymmetric canister/chain-key signatures before operating with
  controllers that should not be able to mint user tokens.
- Marketplace release URLs must be HTTPS GitHub Release assets under the exact
  repository and tag whose ownership was verified. A failed verification
  consumes its challenge; request a new challenge before retrying.
- Run `cargo clippy --all-targets -- -D warnings`, the PocketIC suite, and
  `cargo audit` against `backend/Cargo.lock` for every release.

## Adding official template products

Backend controllers can seed a project template directly with
`add_marketplace_template`. The method accepts one `MarketplaceTemplateInput`
record containing the listing text, repository, release tag, manifest URL,
package slug, and SHA-256 hash of the exact `canister_hub.toml` bytes. It does
not require `register_repo_publisher`; that workflow remains for third-party
publishers. Templates created this way are always public and free.

The normalized repository plus `package_slug` is the template's stable
identity. Calling the method again for that pair updates the product while
preserving its marketplace id, creation time, and download count.

## Semantic search (`downloads` / `record_download`)

Every `MarketplaceItem` carries a `downloads` counter, bumped via
`record_download`, whose only consumer today is `orchestrator`'s
`search_marketplace` tool: it breaks ties between otherwise
equally-relevant semantic search results by picking the more popular item.
It's not tied to any real payment/entitlement flow (unlike the vetKD access
control above) - just a number anyone can increment. See `hnsw_index/README.md`
and `services/orchestrator/README.md`'s "Semantic marketplace search" section for how
descriptions actually get indexed and searched.

See `services/orchestrator/README.md` for the orchestrator side of this flow.
