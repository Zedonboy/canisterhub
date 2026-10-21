# ic-kv

A small Internet Computer canister that behaves like a key-value store:
`get`/`set`/`delete` a key directly against this canister's own persisted
state. No connection, client library, or schema required.

## Methods

- **`set(key: text, value: Value) -> opt Value`** (update) - returns the
  key's previous value, if any (`null` if it didn't exist).
- **`set_many(entries: vec record { text; Value }) -> nat64`** (update) -
  sets every pair in one call; a later entry wins on a repeated key. Returns
  how many were set.
- **`get(key: text) -> opt Value`** (query) - `null` if the key doesn't exist.
- **`get_many(keys: vec text) -> vec opt Value`** (query) - preserves order;
  a missing key comes back as `null` in its slot rather than shrinking the
  result, so `results[i]` always corresponds to `keys[i]`.
- **`delete(key: text) -> opt Value`** (update) - returns the value that was
  removed, if any.
- **`exists(key: text) -> bool`** (query)
- **`keys(prefix: opt text) -> vec text`** (query) - every key, sorted, or
  only ones starting with `prefix`.
- **`len() -> nat64`** (query)
- **`clear() -> nat64`** (update) - empties the store, returns how many
  entries it held. Irreversible - there's no confirmation step or undo.

`Value` is one of `Null | Integer(int64) | Float(float64) | Text(text) |
Boolean(bool) | Bytes(blob)`.

## What this is not

There's no TTL/expiry, no atomic compare-and-swap or transactions across
multiple keys (each call is its own atomic step, but there's no way to make
several `set`/`delete` calls succeed or fail together), and no
subscribe/notify - a caller has to poll `get`/`get_many` to see a change.
`set_many` is the closest thing to a transaction: every pair in one call
either all land or (if the call itself fails, e.g. an unrelated
trap/timeout) none do, but there's no per-key precondition check.

## Architecture (why results are exactly reproducible)

The store (`src/engine.rs`) is a pure, side-effect-free "functional core":
every operation is a deterministic function from one immutable `Store` value
to the next - the same store and the same call always produce the same
result, and a "write" never mutates the store it was given, only returns a
new one.

## Persistence and its limit

The live store lives in this canister's heap memory and is serialized to
stable memory only at upgrade boundaries (`pre_upgrade`/`post_upgrade`), not
per-call - a deliberate simplicity/size tradeoff (see README.md's
"Persistence" section). That means: **the whole store must fit comfortably
in one canister's memory and serialize within one upgrade's instruction
budget.** This is not the place to store millions of keys or data another
canister generates continuously at high volume - for that, build (or point
at) something backed by `ic_stable_structures::StableBTreeMap` instead.

## Using this from another canister

Call any method like a normal canister method (candid). There's no
authentication or per-caller access control at all in this canister -
anyone who can call it can read, write, and clear every key. Enforce
whatever access rules your use case needs in the *calling* canister, before
deciding what to read or write - not here.

## Candid interface

- `llm_context() -> text` (query, open to any caller) - this document.

See `ic-kv.did` for the exact types.
