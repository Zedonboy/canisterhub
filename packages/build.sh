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
  agent
  assetstorage
  auth
  ic-kv
  ic-sql
  kora-payment
  paystack-payment
  restaurant
  order_inventory
)

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: required command 'cargo' is not installed" >&2
  exit 1
fi

# The canisters below embed their browser UIs' `dist/` directories into their
# own wasm at *compile* time, so every UI must exist before the Cargo build.
# There is no deploy-time asset upload step for these modules.
for ui in table-browser inventory-browser storefront chat-ui payment-ui restaurant-ui; do
  ui_dir="$workspace_dir/$ui"
  if [[ -d "$ui_dir" ]]; then
    echo "Building $ui..."
    if command -v npm >/dev/null 2>&1; then
      (cd "$ui_dir" && npm install && npm run build)
    elif command -v deno >/dev/null 2>&1; then
      (cd "$ui_dir" && deno install --no-lock --allow-scripts && deno task --no-lock build)
    else
      echo "error: either 'npm' or 'deno' is required to build $ui" >&2
      exit 1
    fi
  fi
done

echo "Building packages workspace for wasm32-unknown-unknown..."
echo "Using $(rustc --version)"
cargo build \
  --manifest-path "$workspace_dir/Cargo.toml" \
  --workspace \
  --locked \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$output_dir"

# These packages are no longer part of the installable package catalog. Clear
# artifacts from older builds so they cannot be accidentally uploaded.
rm -f "$output_dir/admin_agent.wasm" "$output_dir/admin_agent.did" \
  "$output_dir/app_api.wasm" "$output_dir/app_api.did" \
  "$output_dir/connector.wasm" "$output_dir/connector.did" \
  "$output_dir/notification.wasm" "$output_dir/notification.did"

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
