# hnsw_index

The Marketplace's semantic-search index: one HNSW vector per published
`MarketplaceItem`, so `orchestrator` can find the closest existing item to a
natural-language request instead of always writing a new canister from
scratch. See `services/orchestrator/src/embeddings.rs` for the indexing/search side of
this (summarizing a description, embedding it, and calling this canister).

This is [`ic_hnsw`](https://github.com/Zedonboy/ic-hnsw)'s own official
prebuilt release, deployed as-is - no custom code of ours runs in this
canister. `canister.yaml` fetches it directly from GitHub Releases by URL
(pinned by tag + sha256) rather than building from source; see "Why a prebuilt
release, not built from source" below for why. `candid/hnsw_index.did` is a
copy of that release's own `.did` asset, embedded into the fetched wasm by
`canister.yaml`'s build step.

## Setup

Deployed from a completely generic wasm, this canister starts with no
collections. `orchestrator` creates the one it needs (`marketplace_items`,
1536-dimensional to match OpenAI's `text-embedding-3-small`) itself on
startup - see `ic::hnsw::ensure_marketplace_items_collection` - so there's no
manual setup step here. Its id is always `0`: `ic_hnsw` has no "get collection
by name" lookup, so `orchestrator` hardcodes it
(`ic::hnsw::MARKETPLACE_ITEMS_COLLECTION_ID`), relying on it being the first
(and, so far, only) collection this canister is ever asked to create.

## Access control

Whichever identity's startup successfully calls `create_collection` becomes
that collection's owner - so `orchestrator`'s own `DEPLOY_IDENTITY_PEM`
identity ends up owning `marketplace_items` automatically, with no separate
`grant_access` step needed, as long as it's the first identity to talk to a
freshly-deployed instance of this canister. A canister controller can always
act on any collection regardless (see `ic_hnsw`'s own README for the full
access-control model this canister exposes unmodified).

## Why a prebuilt release, not built from source

`ic_hnsw`'s README documents two integration modes: "Mode A" - deploy its own
prebuilt wasm - and "Mode B" - depend on it as a library and re-expose its
endpoints yourself via its `export_hnsw!()` macro (e.g. to add your own
methods, or an `init` hook, alongside it). Mode B was tried first here (to add
exactly that - an init hook creating this collection automatically). It
doesn't actually work with the published 0.1.0 crate: its own crate root
unconditionally defines the same endpoints `export_hnsw!()` also generates,
regardless of whether a consuming crate calls the macro. Depending on it and
calling `export_hnsw!()` produces two compiled definitions of every endpoint -
`rust-lld` fails with `duplicate symbol: canister_update create_collection`
(and the same for every other endpoint) - one from `ic_hnsw`'s own rlib, one
from the macro expansion. Depending on it *without* calling the macro instead
silently drops every HNSW endpoint from the compiled wasm (nothing tells the
linker to keep and export them).

Mode A - what this canister actually uses - has no such problem, since
`ic_hnsw`'s crate is then the thing actually compiled to wasm, not a
dependency of something else. The tradeoff is losing the init-hook
convenience Mode B would have given; `orchestrator` bootstrapping the
collection itself (see "Setup" above) recovers that without needing any
canister-side code at all.

## Rebuilding / updating to a new upstream release

```sh
icp build hnsw_index
```

To pick up a new `ic_hnsw` release: update the `url` and `sha256` in
`canister.yaml` together (deliberately pinned to one release tag rather than
`/releases/latest/download/...`, so this doesn't change out from under you
between builds), and refresh `candid/hnsw_index.did` from that release's own
`.did` asset if its interface changed.
