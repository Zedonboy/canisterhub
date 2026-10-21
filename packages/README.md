# Canister packages workspace

This directory is the Cargo workspace root for every Rust canister package.
Run workspace commands here, for example:

```sh
cargo check --workspace
cargo test --workspace --lib
```

Dependency versions belong in `[workspace.dependencies]` in `Cargo.toml`.
Members inherit them with `dependency.workspace = true`. The workspace keeps
both supported IC CDK lines: `ic-cdk` for 0.19 and the renamed `ic-cdk-020`
entry for packages that require 0.20.

## Build deployable packages

Build every workspace canister and collect the optimized WASM and Candid
artifacts under `bin/`:

```sh
./build.sh
```

The script performs a locked release build for `wasm32-unknown-unknown` and
writes `bin/<package>.wasm` plus `bin/<package>.did`. It uses the native Rust
toolchain only and requires `cargo` with the Rust WASM target installed.
