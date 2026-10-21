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
