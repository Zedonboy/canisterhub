#!/usr/bin/env bash

set -euo pipefail

workspace_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="$workspace_dir/target/wasm32-unknown-unknown/release"
output_dir="$workspace_dir/bin"

# Rustup selects a directory's rust-toolchain.toml from the process working
# directory, not from Cargo's --manifest-path. Enter the workspace so this
# script always uses packages/rust-toolchain.toml (Rust 1.94), including when
# VS Code or another task runner launches it from the repository root.
cd "$workspace_dir"

packages=(
  admin_agent
  agent
  app_api
  auth
  connector
  ic-kv
  ic-sql
)

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: required command 'cargo' is not installed" >&2
  exit 1
fi

# `ic-sql` embeds this app's `dist/` into its own wasm at *compile* time
# (see `ic-sql/src/assets.rs`), so it must exist on disk before the Cargo
# build below runs - there's no deploy-time upload step to lean on instead.
table_browser_dir="$workspace_dir/table-browser"
if [[ -d "$table_browser_dir" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "error: required command 'npm' is not installed (needed to build table-browser)" >&2
    exit 1
  fi
  echo "Building table-browser (embedded into ic-sql)..."
  (cd "$table_browser_dir" && npm install && npm run build)
fi

echo "Building packages workspace for wasm32-unknown-unknown..."
echo "Using $(rustc --version)"
cargo build \
  --manifest-path "$workspace_dir/Cargo.toml" \
  --workspace \
  --locked \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$output_dir"

for package_name in "${packages[@]}"; do
  artifact_name="${package_name//-/_}.wasm"
  source_wasm="$target_dir/$artifact_name"
  candid_file="$workspace_dir/$package_name/$package_name.did"
  output_wasm="$output_dir/$package_name.wasm"

  if [[ ! -f "$source_wasm" ]]; then
    echo "error: Cargo did not produce $source_wasm" >&2
    exit 1
  fi
  if [[ ! -f "$candid_file" ]]; then
    echo "error: missing Candid interface $candid_file" >&2
    exit 1
  fi

  cp "$source_wasm" "$output_wasm"
  cp "$candid_file" "$output_dir/$package_name.did"

  echo "Created bin/$package_name.wasm"
done

echo "Built ${#packages[@]} packages into $output_dir"
