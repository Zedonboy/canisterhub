# vector_db

A general-purpose vector similarity search database, deployed as a
standalone canister meant to be published/reused as a marketplace item -
alongside `packages/ic-sql` (SQL) and `packages/ic-kv` (key-value), this is
the "vector database" member of that family. Supports creating one or more
named collections (each with its own dimension/distance metric/HNSW
parameters), inserting vectors with metadata, and approximate nearest-
neighbour search.

## Why this is a prebuilt release, not custom code

This is [`ic_hnsw`](https://github.com/Zedonboy/ic-hnsw)'s own official
prebuilt release, deployed as-is - no custom code of ours runs in this
canister. That's a deliberate choice, not a shortcut: this repo already
depends on `ic_hnsw` for exactly this purpose (see `hnsw_index/`, the
Marketplace's own internal semantic-search index), so it's already been
verified end to end here - reusing it again for a general-purpose "vector
database" product is strictly lower-risk than writing and verifying a new
implementation from scratch, or than adopting a different third-party
project (e.g. [ArcMind Vector DB](https://github.com/arcmindai/arcmindvector),
found while checking what else exists - a plausible alternative, but an
unverified one in this codebase, whereas `ic_hnsw` already has a working
integration to point to).

`canister.yaml` fetches it directly from GitHub Releases by URL (pinned by
tag + sha256) rather than building from source - the exact same release
`hnsw_index/canister.yaml` uses, and the exact same reasoning; see that
package's README's "Why a prebuilt release, not built from source" section
for the full explanation (in short: `ic_hnsw`'s "depend on it as a library"
integration mode doesn't actually work as published - trying it produces
either duplicate-symbol linker errors or silently drops every endpoint).

**This is a separate deployment from `hnsw_index/`**, not the same canister
reused. `hnsw_index/` is this repo's own internal plumbing (owned by
`orchestrator`, hosting exactly one collection - `marketplace_items` - that
`orchestrator` creates and manages itself); `vector_db` is meant to be
published and handed to a *customer* as their own general-purpose vector
database, with no assumptions about what collections they create in it or
who else talks to it.

## No `llm_context` method

Unlike `ic-sql`/`ic-kv` (each of which serves a live `llm_context() -> text`
query for an AI agent to discover their own API/limits from), this canister
can't have one: it's `ic_hnsw`'s own unmodified prebuilt Wasm, and adding a
method here means adding custom code, which is exactly the integration this
package's own "Why this is a prebuilt release, not custom code" section
above documents as broken (duplicate-symbol linker errors or silently
dropped endpoints, depending on how it's attempted). This README - and
`ic_hnsw`'s own upstream docs - are the closest equivalent; an agent working
with this canister should be pointed at this file directly rather than a
live method.

## Setup

Deployed from a completely generic wasm, this canister starts with no
collections - a consumer creates their own via `create_collection`. Whichever
identity's call to `create_collection` succeeds becomes that collection's
owner (see `ic_hnsw`'s own README for its full access-control model, exposed
here unmodified) - there's no separate setup step beyond that first call.

## Rebuilding / updating to a new upstream release

```sh
icp build vector_db
```

To pick up a new `ic_hnsw` release: update the `url` and `sha256` in
`canister.yaml` together (deliberately pinned to one release tag rather than
`/releases/latest/download/...`, so this doesn't change out from under you
between builds), and refresh `candid/vector_db.did` from that release's own
`.did` asset if its interface changed.
