# analytics

A general-purpose metrics/analytics canister, deployed as a standalone
canister meant to be published/reused as a marketplace item - alongside
`packages/ic-sql` (SQL), `packages/ic-kv` (key-value), and `packages/vector_db`
(vector similarity search), this is the "analytics" member of that family.
Records counters, gauges, logs, and histograms under arbitrary named keys,
serves them back over Candid queries, accepts authenticated metric writes
over plain HTTP (for callers that aren't IC agents), and can run small
transformer scripts against stored data server-side.

## Why this is a prebuilt release, not custom code

This is [`ic-analytics`](https://github.com/Zedonboy/ic-analytics)'s own
official prebuilt "user canister" release, deployed as-is - no custom code of
ours runs in this canister. Same reasoning as `packages/vector_db` and
`hnsw_index`: reusing an already-published, versioned release is
lower-risk than writing a new metrics-storage implementation from scratch.

`canister.yaml` fetches it directly from GitHub Releases by URL (pinned by
tag + sha256) rather than building from source - see that file's own comments
for why the (here redundant, but kept for consistency and future-proofing)
candid-embedding script step is still there.

## Setup: this canister needs init arguments

Unlike `vector_db`/`ic-sql`/`ic-kv`, this canister is **not** a blank slate
you can deploy with no arguments - its `service` constructor requires an
`AnalyticsMeta` record:

```candid
type AnalyticsMeta = record {
  name : text;
  user_id : principal;
  master_canister : principal;
};
```

Upstream, `ic-analytics` is a hub-and-spoke system: a registry/"master"
canister (`ic-analytics-backend`) deploys one of these "user canisters" per
customer and fills in `AnalyticsMeta` itself at install time. This package
deploys the user canister *without* that registry in front of it - there is
no master canister running anywhere in this repo - so whoever deploys this
package has to supply `AnalyticsMeta` explicitly, e.g.:

```sh
icp deploy analytics --args '(record { name = "my analytics"; user_id = principal "aaaaa-aa"; master_canister = principal "aaaaa-aa" })'
```

- `name` - a human-readable label for this analytics instance (returned by
  `get_analytics_name`). Anything you like.
- `user_id` - recorded but not otherwise enforced by anything visible in this
  canister's own interface; a real value (e.g. the deploying identity's own
  principal) is more useful than a placeholder if anything downstream ever
  reads it back.
- `master_canister` - since there's no real master here, this has to point
  *somewhere*, but nothing in this canister's `.did` grants it privileged
  access - it's only consulted by `upgrade_metric_canister` (see below).
  Passing the deploying identity's own principal, or this canister's own id
  once known, is a reasonable placeholder.

### `upgrade_metric_canister` won't do anything useful here

That one method calls back to `master_canister` to check for a newer
release and, if found, asks it to schedule a wasm upgrade. With no real
`ic-analytics-backend` registry deployed, that call will simply fail (or,
if `master_canister` happens to be a live canister of some other kind,
fail more confusingly) - to pick up a new upstream release of this canister,
update `canister.yaml`'s pinned url/sha256 instead (see below) and redeploy
normally through this repo's own tooling.

## Ingesting metrics

Two paths, both already part of the unmodified upstream interface:

- **From an IC agent/canister**: call `record_metric` directly with a
  `Metric { key, name, value }`, where `value` is one of `Counter`, `Gauge`,
  `Log`, `Histogram`, or `TimeSeries`.
- **From outside the IC** (a plain HTTP client): call `generate_api_key`
  once to mint an `icm_<base64url>` key (shown exactly once - only its hash
  is stored), then send metric writes as authenticated HTTP requests -
  `Authorization: Bearer <api_key>` plus a JSON body - to this canister's
  `http_request`/`http_request_update` endpoints. See `candid/analytics.did`'s
  comments on those two methods for the exact JSON shape.

Stored data is read back via `get_metric`/`get_all_metrics` (latest value per
key) and `get_log_page`/`get_histogram_page` (paginated/range-filtered raw
points), or derived on the fly with `register_transformer` +
`run_transformer` (small scripts that read stored counters/gauges/
histograms/logs and compute a scalar, series, or text result).

## No `llm_context` method

Like `vector_db`, this canister can't have one: it's `ic-analytics`'s own
unmodified prebuilt Wasm, so adding a method here would mean adding custom
code on top of a third-party release we've deliberately chosen not to fork.
This README is the closest equivalent; an agent working with this canister
should be pointed at this file (and `candid/analytics.did`'s own inline
comments) directly rather than a live method.

## Rebuilding / updating to a new upstream release

```sh
icp build analytics
```

To pick up a new `ic-analytics` release: update the `url` and `sha256` in
`canister.yaml` together (deliberately pinned to one release tag rather than
`/releases/latest/download/...`, so this doesn't change out from under you
between builds), and refresh `candid/analytics.did` from that release's own
`ic-analytics-user-canister.did` asset if its interface changed.
