# ic-kv

An Internet Computer canister that behaves like a small key-value store:
`get`/`set`/`delete` a key directly - no client library, connection, or
schema required. The value type covers the common cases directly
(`Null`/`Integer`/`Float`/`Text`/`Boolean`/`Bytes`) rather than requiring the
caller to encode everything as an opaque blob.

Same architecture as [`ic-sql`](../ic-sql) (see that package's README for the
full rationale, which applies unchanged here): the store (`src/engine.rs`) is
a pure, side-effect-free "functional core" - every operation is a
deterministic transformation from one immutable `Store` value to the next,
backed by [`im`](https://docs.rs/im)'s persistent (structurally-shared) maps
rather than `std::collections::BTreeMap`, so "modify" is `O(log n)` and
shares unaffected structure with the original, not a deep copy. `src/lib.rs`
is the thin imperative shell: it holds the canister's one live `Store` in a
`thread_local`, and every endpoint is just "load, call the matching `engine`
function, store the result back."

## Persistence

Same tradeoff as `ic-sql`, for the same reason: the live `Store` lives in
heap memory and is serialized to stable memory in `pre_upgrade`, restored in
`post_upgrade`, via `ic_cdk::storage::stable_save`/`stable_restore` (one
whole-store snapshot, not an incremental structure) - simple and genuinely
functional, at the cost of a practical ceiling on total data size. A version
meant to hold far more data would want `ic_stable_structures::StableBTreeMap`
instead.

## API

- `set(key: text, value: Value) -> opt Value` (update) - returns the
  previous value, if any.
- `set_many(entries: vec record { text; Value }) -> nat64` (update) - sets
  every pair in one call (a later entry wins on a repeated key); returns how
  many were set.
- `get(key: text) -> opt Value` (query)
- `get_many(keys: vec text) -> vec opt Value` (query) - preserves order; a
  missing key comes back as `null` in its slot rather than shrinking the
  result.
- `delete(key: text) -> opt Value` (update) - returns the value that was
  removed, if any.
- `exists(key: text) -> bool` (query)
- `keys(prefix: opt text) -> vec text` (query) - sorted; optionally
  restricted to keys starting with `prefix`.
- `len() -> nat64` (query)
- `clear() -> nat64` (update) - empties the store, returns how many entries
  it held.
- `llm_context() -> text` (query, open to any caller) - a prose description
  of this canister for an AI agent (or a human) to consume: the API, what
  it deliberately doesn't do (TTL, transactions, subscriptions), and its
  persistence tradeoffs. Served from `src/llm_context.md` via
  `include_str!`, so it's always in sync with what's actually committed
  there.

`Value` is `Null | Integer(int64) | Float(float64) | Text(text) |
Boolean(bool) | Bytes(blob)`. See `ic-kv.did` for the exact Candid types.

## Example

```sh
dfx canister call ic-kv set '("user:1", variant { Text = "alice" })'
dfx canister call ic-kv get '("user:1")'
dfx canister call ic-kv keys '(opt "user:")'
```

## Regenerating `ic-kv.did`

Hand-committed, not auto-generated at build time - matches this repo's other
canisters' convention.

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/ic_kv.wasm > ic-kv.did
```

(Cargo compiles the package's hyphenated name `ic-kv` to the Wasm file
`ic_kv.wasm` - ordinary Rust crate-name mangling, not a typo.)

## Testing

```sh
cargo test --lib   # engine.rs's pure-core unit tests - no Wasm build needed
cargo build --target wasm32-unknown-unknown --release
cargo test          # + tests/ic_kv_tests.rs's PocketIC integration tests
```

`cargo test --lib` covers the store directly: get/set/delete/exists,
overwrite returning the previous value, prefix-filtered `keys`, `set_many`/
`get_many`, `clear`, an explicit check that a mutation never changes the
`Store` it was given, and that a `Snapshot` round-trips a `Store` exactly
(the same conversion `pre_upgrade`/`post_upgrade` use).

`tests/ic_kv_tests.rs` (real PocketIC, not a stub - set `POCKET_IC_BIN` to a
local server binary to avoid a download on first run) exercises the actual
canister interface end to end, plus the one thing the pure unit tests
structurally can't reach: that data survives a real `pic.upgrade_canister`
call, proving `pre_upgrade`/`post_upgrade` actually work.
