# canister_hub Orchestration Agent

An axum HTTP server that acts as an LLM-driven Orchestration Agent (via
[`rig`](https://docs.rs/rig-core)) for canister_hub. Its core idea: decompose
a request into a fixed set of known, reusable **building block** canisters
rather than always writing one bespoke canister from scratch.

1. **Semantically searches the Marketplace** for something that already
   covers the whole request - not keyword matching: the request is embedded
   and matched against `hnsw_index`, a vector index of every published item's
   description (see "Semantic marketplace search" below). If a free match
   exists, downloads its release wasm and deploys it as-is.
2. Otherwise, **decomposes the request into building blocks** - connector
   (receives messages from the outside world), agent (user-facing
   LLM tool-calling), admin_agent (controller-only actions), a database
   (ic-sql/ic-kv/vector_db), static (the web app's own frontend), assets
   (media storage) - and assembles them as **one real multi-canister icp-cli
   project**, mirroring how this very repo's own root `icp.yaml` lists
   several canisters together.
3. **Delegates each canister to a coding subagent** - a separate, in-process
   `rig` agent equipped with its own file/shell toolset modeled closely on a
   real coding agent's ([OpenCode](https://opencode.ai)'s, specifically - see
   "The coding subagent" below and `src/llm/codetools.rs`'s doc comment).
   Four of the six blocks (connector/admin_agent/database/agent's
   base) are added via known-good source, not rewritten - only
   agent's business-specific tools and static's actual page content
   are genuinely bespoke per request. Every canister writes and runs its own
   tests before the subagent reports back.
4. **Deploys and wires the whole project for real**: once every needed
   canister is in place, one final subagent call runs icp-cli's own real
   `icp deploy -e ic` (not a hand-rolled install) and connects the deployed
   canisters together (e.g. connector ↔ agent) via `icp canister
   call ... update_config`.

The top-level agent never sees a subagent's intermediate steps, only its
final summary - and doesn't just trust that summary either: it independently
re-confirms each canister's real deployed id via `icp canister status -i`
rather than relying on the subagent's self-report (see `write_and_compile_project`'s
own doc comment in `src/llm/tools.rs`).

Both the top-level agent and every coding subagent share the same LLM
provider setting - pick any of OpenAI / Anthropic / Gemini / Ollama /
DeepSeek via `LLM_PROVIDER` (see below) - since both are just `rig` agents
run through the same `run_agent` helper with a different preamble/toolset/
turn-budget. See `src/llm/mod.rs`'s `PREAMBLE` for exactly what the
top-level agent is told to do, `src/llm/tools.rs` for what each of its tools
does - including `write_and_compile_project`, the tool that spins up a
subagent - and `src/llm/mod.rs`'s `coding_subagent_preamble` plus
`src/llm/codetools.rs` for a subagent's own instructions and tools.

## Prerequisites

- `icp` (icp-cli) installed directly on the host running this server, on
  `PATH` - every `icp new`/`icp build`/`icp deploy`/`icp canister call` a
  coding subagent runs (via its `shell`/`shell_send` tools) executes right
  there, not inside any sandbox (see "Notes and limitations" below for what
  that means).
- Rust with the `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`) - needed to build the canisters a subagent
  assembles.
- Node.js/npm, only because `icp-cli` itself is distributed as an npm
  package that fetches the real binary on install.
- This repo's own `packages/` checkout reachable on disk - by default at
  `./packages` relative to wherever this server's working directory is, or
  wherever `BUILDING_BLOCKS_DIR` points instead (see Configuration below).
  A coding subagent copies `connector`/`agent`/`admin_agent`/
  `ic-sql`/`ic-kv`/`vector_db` straight from there via `icp new --path`, so
  nothing needs to be baked into an image ahead of time any more.
- An identity, either as `IDENTITY_SEED_PHRASE` (a BIP-39 seed phrase - the
  same kind `dfx identity new` prints, derived the same way, so it produces
  the identical principal in both places) or `DEPLOY_IDENTITY_PEM` (a PEM
  file, e.g. `dfx identity export <name> > identity.pem`). If both are set,
  the seed phrase wins. Always required, even for read-only/local use:
  startup bootstraps `hnsw_index`'s `marketplace_items` collection (see
  `hnsw_index/README.md`'s "Setup" section), which needs a real identity, and
  that same identity automatically ends up owning it - no separate
  access-grant step needed as long as it's the first identity to talk to a
  freshly-deployed `hnsw_index`. Additionally required to be a controller of
  `backend` whenever `REQUIRE_AUTH=true` (the default - see Authentication
  below), since fetching its JWT signing key at startup is a controller-only
  call. Whichever form you use, treat it like a private key - it is one.

  This same identity is also what a coding subagent's final "deploy the
  whole project" call uses for `icp deploy -e ic` - staged into that job's
  workspace as a file only for the duration of that one call (see
  `write_and_compile_project_tool`'s `write_deploy_identity_file`), then
  removed. It needs mainnet cycles of its own (via icp-cli's own
  `icp cycles mint`/cycles-ledger integration, not a classic `dfx`-style
  wallet canister - `icp deploy --cycles` funds canister creation directly
  from the identity's own balance) for that step to succeed.
- For deploying a *marketplace item* to mainnet specifically (a different,
  older path - `deploy_marketplace_item`'s hand-rolled `ic-agent` install,
  unchanged by the above): a classic cycles wallet canister your identity
  controls. Local/test deploys of either kind don't need one - the replica
  mints cycles provisionally instead.
- An API key for whichever LLM provider you choose (not needed for Ollama), plus
  an OpenAI key regardless (embeddings are always OpenAI - see below). The
  coding subagent uses the same provider/key - see "The coding subagent"
  below.

## Configuration

All configuration is environment variables (see `src/config.rs`):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MARKETPLACE_CANISTER_ID` | yes | - | The `backend` canister's id |
| `HNSW_CANISTER_ID` | yes | - | The `hnsw_index` canister's id |
| `SEARCH_TOP_K` | no | `5` | Nearest neighbours requested per `search_marketplace` call |
| `SEARCH_RELEVANCE_THRESHOLD` | no | `0.4` | Cosine-distance cutoff above which a result is dropped as not actually relevant |
| `BIND_ADDR` | no | `0.0.0.0:8787` | HTTP listen address |
| `WORKSPACE_ROOT` | no | `./data/jobs` | Where each job's files live |
| `IC_URL_LOCAL` | no | `http://127.0.0.1:4943` | Replica URL for `network: "local"` |
| `IC_URL_MAINNET` | no | `https://ic0.app` | Replica URL for `network: "ic"` |
| `IDENTITY_SEED_PHRASE` | one of these two | - | BIP-39 seed phrase, derived the same way `dfx` does - see Prerequisites |
| `DEPLOY_IDENTITY_PEM` | one of these two | - | Path to a Secp256k1 or Ed25519 PEM - see Prerequisites |
| `CYCLES_WALLET_CANISTER_ID` | for mainnet deploys | - | Your cycles wallet canister |
| `CANISTER_CREATION_CYCLES` | no | `3000000000000` (3T) | Cycles per new canister |
| `COMMAND_TIMEOUT_SECS` | no | `600` | Hard timeout for any single command a coding subagent runs |
| `SHELL_IDLE_TIMEOUT_SECS` | no | `20` | How long an interactive `shell`/`shell_send` session can go idle before being reported back as "probably waiting on input" - see "The coding subagent" below |
| `BUILDING_BLOCKS_DIR` | no | `../packages` | Where a coding subagent copies known-good building-block canister source from |
| `LLM_PROVIDER` | no | `openai` | `openai` \| `anthropic` \| `gemini` \| `ollama` \| `deepseek` - top-level agent only |
| `LLM_MODEL` | no | provider default | Overrides the top-level agent's model name |
| `LLM_MAX_TURNS` | no | `24` | Max tool-calling turns for the top-level orchestration agent, per request |
| `LLM_SUBAGENT_MAX_TURNS` | no | `12` | Max tool-calling turns for the coding subagent, per `write_and_compile_project` call |
| `ASK_USER_TIMEOUT_SECS` | no | `1800` (30 min) | How long the coding subagent's `ask_user` tool waits for a human's answer via `POST /jobs/:id/answer` before giving up |
| `OLLAMA_TOOL_RESULT_SHIM` | no | `true` | Only relevant for `LLM_PROVIDER=ollama` - see "Testing" below before turning this off for a model you haven't verified |
| `ICP_TEMPLATE_GIT` | no | `dfinity/icp-cli-templates` | Template repo for `icp new` |
| `ICP_TEMPLATE_SUBFOLDER` | no | `rust` | Template subfolder |
| `REQUIRE_AUTH` | no | `true` | Require a valid `Authorization: Bearer <jwt>` - see Authentication |
| `AUTH_NETWORK` | no | `local` | Replica hosting `backend`/`hnsw_index`: `local` \| `ic`. Used for the startup JWT-key fetch and every `/index_marketplace_item` call |
| `GITHUB_OAUTH_CLIENT_ID` | for "Connect Git" | - | Client id of a GitHub OAuth App - see "Connect Git" below |
| `GITHUB_OAUTH_CLIENT_SECRET` | for "Connect Git" | - | That OAuth App's client secret |
| `PUBLIC_BASE_URL` | for "Connect Git" | - | This server's own externally-reachable base URL, no trailing slash (e.g. `https://orchestrator.example.com`) - must match the OAuth App's configured callback host |
| `GITHUB_API_TOKEN` | no | - | Optional GitHub token (read-only "Attestations" permission) for the build-provenance check below. Unset sends that one API call unauthenticated, which GitHub still serves for public repos at a lower rate limit |

Plus `OPENAI_API_KEY` (always needed - embeddings are always OpenAI, regardless
of `LLM_PROVIDER`; see "Semantic marketplace search" below) and whichever
other API-key env var your chosen `LLM_PROVIDER` expects (`ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`; Ollama needs none by default, and reads
`OLLAMA_API_BASE_URL` if it's not on `localhost:11434`).

## Running

```sh
export MARKETPLACE_CANISTER_ID=<backend canister id>
export HNSW_CANISTER_ID=<hnsw_index canister id>
export IDENTITY_SEED_PHRASE="your twelve or twenty-four word seed phrase"
# ...or export DEPLOY_IDENTITY_PEM=./identity.pem instead
export OPENAI_API_KEY=sk-...
cargo run
```

## Authentication

Mutation endpoints such as `POST /orchestrate` require an
`Authorization: Bearer <token>` header, where `<token>` is a JWT `backend`
issued (see `backend/README.md`'s "API access tokens" section for the full
canister-side flow):

1. A user authenticates with **Internet Identity** in your frontend, giving
   them a principal + delegation they can call canisters with.
2. The frontend calls `backend.issue_jwt()` (an authenticated update call) and
   gets back a short-lived (1 hour) HS256 JWT bound to that principal.
3. The frontend attaches it as `Authorization: Bearer <jwt>` on every request
   to this server.

The orchestrator never talks to Internet Identity or verifies delegations
itself - it trusts `backend`'s signature on the JWT, which it fetches once at
startup (`get_jwt_signing_key`, controller-only) and checks locally after
that. A job is only ever readable by the principal whose token created it.

Once a token passes verification, its (principal, expiry) is cached in memory
keyed by the raw token, so a frontend reusing the same token across many
requests - the normal case, since a token is valid for an hour - only pays
for the HMAC check once. Failed verifications are never cached.

Set `REQUIRE_AUTH=false` to disable this entirely (every caller is treated as
the anonymous principal, and jobs are no longer isolated per-caller) - only
for local development without an Internet Identity setup.

## API

Project template deployment is not part of this API - it's entirely
client-side now (`frontend/src/lib/templates.ts`): the browser downloads
and validates a `Template` marketplace item's `canister_hub.toml` itself,
installs each declared package directly via the management canister (the
same direct-install pattern `lib/deploy.ts` uses for a single marketplace
item), and configures each one through its own `ic::config` surface
(`get_config_schema`/`set_config`), prompting the user for anything the
manifest didn't already supply a default for. No LLM, no orchestrator
involvement, no job to observe.

### `POST /orchestrate`

```json
{ "request": "a canister that stores a counter and lets anyone increment it", "network": "local" }
```
→ `{ "job_id": "..." }`. `network` is `"local"` (default) or `"ic"`.

### `GET /jobs/:id`

Returns the job's current state (`"running"` | `"awaiting_answer"` |
`"succeeded"` | `"failed"`), its tool-call log (compiler output included, so
you can watch the fix→rebuild loop happen), and, on success, the resulting
`canister_id`. When `state` is `"awaiting_answer"`, `pending_question` holds
the coding subagent's question - see `POST /jobs/:id/answer` below. Also
includes `token_usage` (`input_tokens`/`output_tokens`/`total_tokens`/
`cached_input_tokens`/`cache_creation_input_tokens`/`tool_use_prompt_tokens`/
`reasoning_tokens`) - the running total of every LLM model call spent on
this job, top-level orchestration agent and every coding subagent combined
(see `Job::add_usage`, `src/job.rs`, and `llm::AgentRunOutcome`,
`src/llm/mod.rs`, for how it's accumulated - via a `rig` `AgentHook`, since
the plain `.prompt()` call this server uses doesn't expose usage on its
own). Present and updated even for a job that ends up `"failed"`: real
tokens are spent on the turns leading up to a failure too. A field the
provider didn't report comes back as `0` - `rig`'s own documented sentinel
for "not reported," not necessarily "none used." 404s for a job id that
exists but belongs to a different caller, same as one that doesn't exist at
all.

### `POST /jobs/:id/answer`

```json
{ "answer": "use a 24-hour retry window" }
```
→ `{ "success": true }`.

Answers a job's pending question from its coding subagent's `ask_user` tool
(see `src/llm/codetools.rs`'s doc comment on that tool, and
`src/job.rs`'s doc comment on `JobStore` for how this actually reaches a
paused tool call across the job's background task). 409s if the job isn't
currently `"awaiting_answer"` - already answered, never asked anything, or
the subagent's own wait already timed out (`ASK_USER_TIMEOUT_SECS`, default
30 minutes) and it moved on without one.

### `POST /index_marketplace_item`

```json
{ "item_id": 42 }
```
→ `{ "success": true, "item_id": 42, "node_id": 7, "summary": "...", "keywords": ["..."] }`

Call this once, right after a successful `backend.publish_marketplace_item`, with the id
it returned - see "Semantic marketplace search" below. Requires auth like the
other endpoints, but doesn't scope by caller (indexing isn't tied to a
specific requester the way a job is).

### `GET /health`

Unauthenticated.

### "Connect Git"

- `GET /github/connect/start?repo_url=...&publisher=...` (requires auth) -
  returns `{ "authorize_url": "..." }`, a GitHub OAuth consent URL to open in
  a popup.
- `GET /github/connect/callback?code=...&state=...` - hit directly by
  GitHub's own redirect, never called by a frontend. Always responds `200`
  with a small HTML page that `postMessage`s the outcome to `window.opener`
  and closes itself.

See "Connect Git" below for what this is actually for.

## Connect Git

`backend::register_repo_publisher` is controller-only (see its own doc
comment in `backend/src/lib.rs`) - the canister has no way to verify GitHub
repository ownership itself (no HTTPS outcall-based challenge/response is
implemented), so it no longer trusts a bare authenticated caller's claim at
all. This is the replacement: a real GitHub OAuth App (`src/github.rs`)
verifies ownership off-chain, and only this orchestrator - itself a
controller of `backend`, same requirement as the startup JWT-key fetch -
ever calls `register_repo_publisher`, on a user's behalf.

1. The dashboard calls `GET /github/connect/start` with the repo URL and the
   CI `publisher` principal it wants bound to it (see
   `frontend/src/pages/PublisherSetup.tsx` for what that principal is and how
   it's generated). The orchestrator mints a short-lived, single-use `state`
   token recording that claim and returns GitHub's own OAuth authorize URL.
2. The dashboard opens that URL in a popup. The user signs in to GitHub (if
   needed) and approves the OAuth App's `public_repo` access request.
3. GitHub redirects the popup to `GET /github/connect/callback`. The
   orchestrator exchanges the `code` for an access token (requires the OAuth
   App's client secret - the one step in this flow that must happen
   server-side), then calls GitHub's own API to confirm that token's account
   has **admin** access to the claimed repo.
4. Only if that check passes does the orchestrator call
   `register_repo_publisher` itself, as its own controller identity.

Create the OAuth App at <https://github.com/settings/developers> ("OAuth
Apps" → "New OAuth App"), set its callback URL to
`${PUBLIC_BASE_URL}/github/connect/callback`, and set
`GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`/`PUBLIC_BASE_URL`
accordingly. Deployments that don't need marketplace publishing can leave all
three unset - every other endpoint works without them.

## Build provenance

Connect Git proves *who* may claim a repository. It says nothing about
whether a given release artifact actually came from that repository's own
CI - a verified owner could still publish something built elsewhere. For
that, `src/provenance.rs` verifies a GitHub Artifact Attestation
(`actions/attest-build-provenance` - Sigstore-backed, not a shared secret):
it confirms a signing certificate issued by GitHub Actions' real OIDC
issuer, chaining to Sigstore's real trust root, names the exact repository,
and signs exactly the artifact's digest.

`deploy_marketplace_item` (the agent-driven install path for a free item)
calls this and refuses to install without a passing attestation - see
`publish_to_market/action.yml`, which runs that attestation step
automatically as part of publishing (requires the calling workflow to grant
`id-token: write`/`attestations: write` - see `scripts/README.md`). Known
limitation, upstream in the `sigstore` crate (0.14.0) rather than something
added here: Rekor transparency-log inclusion-proof / Signed-Entry-Timestamp
verification isn't implemented yet (`sigstore-rs#285`) - what's checked is
still the certificate chain, the OIDC issuer, the repository identity, and
the signature over the exact digest.

Not yet covered: the frontend's direct-from-browser install path
(`frontend/src/lib/vetkeyDecrypt.ts`, used for paid items and any item a
user installs straight from the dashboard rather than through the
orchestration agent) only checks `wasm_hash`, not build provenance - a real
Sigstore-JS integration there is a separate, disclosed gap, not silently
skipped.

## Push notifications

The protocol backend owns Web Push VAPID configuration, caller-scoped
subscriptions, payload encryption, and HTTPS delivery. Projects do not install
a separate notification canister.

## Semantic marketplace search

`search_marketplace` doesn't keyword-match; it's backed by `hnsw_index`, a
vector index of every published item's description (see `hnsw_index/README.md`).
Two independent flows keep it populated and queryable:

**Indexing** (`POST /index_marketplace_item`, `src/routes/index_item.rs`) -
called once per newly-published item:

1. Fetch the item (`backend.get_marketplace_item`).
2. Summarize its description into a short summary + keywords, via whichever
   `LLM_PROVIDER` is configured (`embeddings::summarize_and_extract_keywords`) -
   a plain single-turn completion, not the tool-calling agent.
3. Embed `title + summary + keywords` with OpenAI's `text-embedding-3-small`
   (`embeddings::embed_text` - always OpenAI here, since `hnsw_index`'s
   collection dimension, 1536, is fixed to that model regardless of
   `LLM_PROVIDER`).
4. `hnsw_index.insert` the vector, with the item's id packed into `metadata`.

**Searching** (`search_marketplace` tool, `src/llm/tools.rs`'s `semantic_search`) -
called by the orchestration agent mid-job:

1. Embed the agent's query the same way (OpenAI, same model).
2. `hnsw_index.search` for the nearest `SEARCH_TOP_K` vectors.
3. Drop anything past `SEARCH_RELEVANCE_THRESHOLD` - an empty result here is
   what tells the agent "nothing close enough exists, write a custom
   canister" rather than always handing back the closest few vectors
   regardless of how unrelated they are.
4. Resolve survivors back to full `MarketplaceItem`s and rank them: closest
   distance first, ties broken by `downloads` (bumped via `backend.record_download`,
   called automatically on every successful `deploy_marketplace_item`) -
   "closest match, then most popular" as the tie-break.

## The coding subagent

`write_and_compile_project` (the top-level agent's only tool for actually
assembling a project) delegates to a second, separate `rig` agent - same
`run_agent` helper as the top-level one, given `coding_subagent_preamble`
instead of `PREAMBLE`, its own `LLM_SUBAGENT_MAX_TURNS` turn budget, and the
toolset in `src/llm/codetools.rs` rather than `src/llm/tools.rs`'s. That
toolset is modeled closely on a real coding agent's -
[OpenCode](https://opencode.ai)'s, specifically, whose actual tool source
(github.com/sst/opencode) this was checked against for tool names and
shapes. Every command a subagent runs executes directly on the host now -
see "Notes and limitations" below for what that does and doesn't mean for
isolation.

Each subagent run is a fresh conversation with no memory of any other call -
it never sees the original `POST /orchestrate` request directly, only
whatever one `write_and_compile_project` call's own `spec` says. So the
subagent's system prompt itself carries the original job request (`Job::request`
- the actual business requirements behind the whole app, e.g. "Create a
Restaurant Food Ordering Service") as its own dynamic argument
(`coding_subagent_preamble(cfg, business_requirements)`), read fresh from the
job on every call rather than left to whatever a given spec happens to
restate. This is what lets the subagent make sensible judgment calls a
narrower per-canister spec doesn't spell out (naming, what a generic example
tool should become, tone in a system_prompt) without guessing at context it
never actually had.

Every subagent call's tools are scoped to the **whole project's root**
(verified directly: `icp new` refuses to generate into a directory that
already exists at all, even empty, so pre-creating and scoping to a
not-yet-existing canister subfolder doesn't work) - only the *spec*
`write_and_compile_project` hands it differs, describing one of two
situations (the preamble is written as one continuous flow rather than
named "modes" - both amount to "look at the project's real state, starting
with its own icp.yaml, then do what the spec asks"):

- **With a `canister_name`**: add or customize the one canister at that
  subfolder. For a known building block, the subagent runs `icp new
  <canister_name> --path <BUILDING_BLOCKS_DIR>/<kind> -s -o --vcs none` -
  verified directly (a real `icp new --path` run against a clean copy of
  `connector`, diffed byte-for-byte against the source) that this copies a
  plain, non-templated directory through completely unchanged, including its
  own `canister.yaml` - then registers the new subfolder in the project's own
  `icp.yaml` as a bare path (matching every other canister already there).
  For static/assets (no source to copy), it writes a `canister.yaml` by hand
  instead (`static-site`/`asset-canister` recipe), registered the same
  bare-path way. Only agent (or a genuinely custom canister) gets
  its actual source edited - the other reusable blocks are used as-is. Every
  canister must have its own tests written and passing (`cargo test`), not
  just `icp build` succeeding, before this call reports done.
- **Without a `canister_name`** (called once, after every needed building
  block's own call has succeeded): deploy the whole project for real (`icp
  deploy -e ic`, icp-cli's own actual mainnet deploy - not a hand-rolled
  install) and wire the deployed canisters together (`icp canister call
  <name> update_config ...` for whichever cross-references the spec names,
  e.g. connector's `agent_canister` ↔ agent's
  `connector_principal`). The identity `icp deploy` needs is staged into the
  project root as a file for the duration of this one call only (see
  `write_deploy_identity_file`), then removed.

A scaffolded project's own `icp.yaml` actually uses two different shapes for
a canister entry - verified directly against a real `icp new`-scaffolded
project, not assumed: most entries are a bare path to a subfolder with its
own `canister.yaml` (`- connector`), but the project's *original default*
canister is listed inline instead (`- name: backend` followed by a nested,
more-indented `recipe:` block right in `icp.yaml`, no separate
`canister.yaml` at all) - just how the `rust` template scaffolds it. The
preamble tells the subagent to recognize both, add every canister it creates
using the bare-path shape (matching the building blocks), and - for a
genuinely custom canister scaffolded via the ordinary template, which
produces its own nested `icp.yaml` in that same inline shape - move that
entry's `name`/`recipe` fields into a proper `canister.yaml` of the new
subfolder's own before deleting the now-redundant nested `icp.yaml`, rather
than trying to inline it into the parent.

The tools themselves, used in every situation:

- **`read`** - a file (line-numbered, paginated) or a directory listing.
- **`write`** - create a file, or fully overwrite one already `read` this
  conversation.
- **`edit`** - replace one exact, uniquely-matching block of text in a file
  already `read` this conversation.
- **`apply_patch`** - apply a multi-file patch (add/update/delete several
  files in one call) in the standard `apply_patch` envelope format
  (`*** Begin Patch` / `*** Add File:` / `*** Update File:` with `@@`-marked,
  context-positioned hunks / `*** Delete File:` / `*** End Patch`) - useful
  for a spec that touches several related files at once.
- **`glob`** / **`grep`** - find files by name pattern / search file contents
  by regex, to orient itself in the scaffolded project.
- **`shell`** / **`shell_send`** - run a command (`icp build`, `cargo test`,
  `cargo add`, any `icp` subcommand, ...) directly on the host, rooted at the
  project directory (or a `cwd` subfolder of it). Genuinely interactive: a
  command spawns under a real pseudo-terminal (`src/process.rs`'s
  `InteractiveSessions`, backed by the `pty-process` crate), and if it shows
  a prompt instead of finishing - `icp new` run without `-s`, for
  instance - `shell` reports `waiting_for_input: true` with a `session_id`
  and whatever was printed so far, rather than hanging. The subagent reads
  that prompt, decides an answer itself (the same reasoning it already does
  every turn), and calls `shell_send` with that answer - repeating as many
  times as the command actually prompts. "Looks like it's waiting on input"
  is a heuristic (`process::looks_like_a_pending_prompt` - idle for
  `SHELL_IDLE_TIMEOUT_SECS` *and* either no trailing newline or the last
  cursor-hide/-show ANSI sequence seen is an unanswered hide), verified
  directly against a real `icp new` run: its `Select` prompt's fully
  rendered frame actually ends in a newline, which is why the cursor-hidden
  signal exists as a second, independent check alongside the plain
  no-trailing-newline one. `timeout_secs` (default `COMMAND_TIMEOUT_SECS`)
  is the hard cap regardless - the command is killed if it neither finishes
  nor prompts within that long.
- **`todowrite`** - an optional, visibility-only task list, logged to the job
  log.
- **`ask_user`** - ask the person who requested this canister a clarifying
  question when the spec is genuinely ambiguous, and wait for their answer.
  Not a live TUI prompt (nothing here runs attended in a foreground
  session) - it's a real pause/resume through this server's own job model:
  the job's state becomes `"awaiting_answer"` (visible via `GET /jobs/:id`,
  along with the question), and `POST /jobs/:id/answer` resumes it - see
  "API" above and `src/job.rs`'s doc comment for the actual channel
  plumbing between the two. Times out after `ASK_USER_TIMEOUT_SECS`
  (default 30 minutes) if nobody answers, at which point the subagent is
  told so and continues on its own judgment rather than waiting forever.

`write`/`edit`/`apply_patch` all enforce read-before-write (refusing to touch
an existing file the subagent hasn't `read` yet this conversation, so it can
never blindly clobber content it hasn't seen) and, for any `.rs`/`Cargo.toml`/
`Cargo.lock` path they touch, automatically run `cargo check` and fold the
result into their own response as `cargo_check` - fast compiler feedback with
no separate tool call. There's no real LSP client behind that (OpenCode's own
`lsp` tool talks to a live language server) - `cargo check` plays that role
here, a deliberate scope cut for a single-project coding subagent rather
than an oversight. Likewise, there's no `task`/`webfetch`/`websearch`/
`plan`/`skill` tool: this subagent is already one level of delegation from
the top-level agent, and `plan`/`skill` specifically are TUI-oriented
concepts with no equivalent here that `ask_user` doesn't already cover.

`write_and_compile_project_tool` (`src/llm/tools.rs`) gives the request its
subagent, hands it its spec as the sole prompt, and - once it returns -
independently verifies success rather than trusting the subagent's own
summary: with a `canister_name`, whether a `.wasm` actually exists on disk
under that canister's own subfolder (`process::find_wasm_artifact`);
without one, each canister's real deployed id, by running `icp canister
status <name> -i -e ic` itself (parsed from the project's own `icp.yaml` - see
`parse_icp_yaml_canister_names`'s own doc comment for the two entry shapes
it handles - not from anything the subagent claimed) and returning only the
ids it could actually confirm. It
also closes out any interactive session the subagent left open
(`ctx.interactive_sessions.close_all()`) once the call finishes, win or
lose - there's no more disposable container to reap an abandoned process
for it.

## Testing

This crate has both a `[lib]` (`src/lib.rs`) and a `[[bin]]` (`src/main.rs`)
target sharing one package name - `main.rs` is a thin entry point that just
calls into the library crate (`orchestrator::config::Config`, etc.) for
everything else. That split exists specifically so an integration test can
build the real `axum::Router` in-process (`orchestrator::routes::router`)
and drive it with real HTTP calls, without needing the compiled binary as a
subprocess or anything its own startup does (a real IC agent, `hnsw_index`
bootstrapping) - see `tests/ask_user_route_tests.rs`, which does exactly
that for the `ask_user`/`POST /jobs/:id/answer` flow: 5 fast, dependency-free
tests covering a question becoming visible via `GET /jobs/:id`, being
answered, timing out, and the various rejection cases (unknown job, no
pending question, empty answer) - all without needing PocketIC or a real LLM.

`cargo test` runs the unit tests (`src/llm/codetools.rs`'s pure-logic tests,
`src/job.rs`'s `Job`/`JobStore` state-machine and channel tests,
`src/ic/agent.rs`'s seed-phrase derivation), the `ask_user_route_tests.rs`
suite above, plus one real end-to-end test,
`tests/marketplace_search_and_deploy_tests.rs`: it publishes `packages/
ic-sql` as a marketplace item on a real PocketIC-backed `backend`/
`hnsw_index`, then drives a real `orchestrator` subprocess purely over its
own HTTP API (`/index_marketplace_item`, `/orchestrate`, `/jobs/:id`) to
confirm the top-level agent (`LLM_PROVIDER=deepseek`) actually finds and
deploys it via `search_marketplace`/`deploy_marketplace_item` - not a
simulation of that flow, the real one, with a scripted local server standing
in only for the LLM's own responses (deterministic and free - no API key
needed to run it). See that file's own doc comment for the prerequisites
(two wasms to build, one release fixture to download) and exactly why it's
structured the way it is.

That test is what caught two real bugs in `src/ic/deploy.rs`, both now
fixed and worth knowing about if that file looks like it could be
simplified back to the more obvious version:

- **`ic-utils`'s automatic chunked-install dispatch doesn't work.**
  `InstallCodeBuilder::call_and_wait()` claims to switch from a single
  `install_code` call to `upload_chunk`/`install_chunked_code` once a wasm
  module passes roughly 1.85MiB - verified directly (a standalone probe
  against a real PocketIC instance) that it doesn't: a module past that
  size still gets sent in one request and fails outright with a
  transport-level "413 Payload Too Large", identically to what an
  intentionally-unchunked call would do. The individual chunked-install
  calls work correctly when driven directly - only `ic-utils`'s own
  size-based dispatch between the two paths is broken. `deploy.rs::install`
  now does that dispatch itself instead of trusting the builder.
- **A local/PocketIC canister creation needs a real `effective_canister_id`
  hint.** Without one, `ic-utils`'s `create_canister()` defaults to the
  management canister's own id (`aaaaa-aa`) for routing the call's
  `read_state` polling - fine against a real replica, but PocketIC's HTTP
  gateway can come back with a certificate for a subnet whose
  `canister_ranges` don't cover the newly created canister, failing with
  `ic-agent`'s own "lookup path ... is unknown in the certificate" error.
  `create_and_install_local` now takes an already-known real canister id
  (`Config::marketplace_canister_id`, unrelated to the marketplace
  otherwise - just a convenient real id) to route through instead.

There are two more `#[ignore]`d tests in the same file that run the
identical scenario against a **real local Ollama model** instead of the
scripted server - not something to run in CI (slow, non-deterministic,
needs Ollama running locally with a model pulled), but a genuine, real pass
when you want one:

```sh
ollama pull llama3.1:8b   # or qwen3.5:9b - see below
cargo test --test marketplace_search_and_deploy_tests -- --ignored --nocapture
```

These tests are what caught a real limitation in Ollama's tool-calling
support - not universal, model-dependent, and worth understanding before
picking a local model to actually run this against:

- `llama31_agent_finds_and_deploys_..._with_the_shim` - verified directly
  (raw `POST /api/chat` probes, bypassing `rig`/this crate entirely) that a
  *first* tool-calling turn reliably gets a real, structured tool call back
  from Ollama on `llama3.1:8b` - but a *second* turn, once a prior call's
  result (a `role: "tool"` message) is anywhere in the history, reliably
  does not: the model narrates the intended call as text instead of
  actually making it (`qwen2.5-coder:7b`, also tried, fails even on the
  *first* turn - not used here at all). Since every real orchestrator run
  needs at least two chained tool calls (`search_marketplace` then
  `deploy_marketplace_item`, at minimum), this isn't a corner case - it's
  the one thing that has to work. `src/llm/ollama_tool_result_shim.rs`
  (wired into `run_agent`'s `"ollama"` branch, on by default via
  `Config::ollama_tool_result_shim`) works around it by rewriting
  `role: "tool"` to `role: "user"` on every outgoing request to Ollama,
  which reliably fixes it (verified the same way).
- `qwen35_agent_finds_and_deploys_..._without_the_shim` - the `qwen3`/
  `qwen3.5` family handles a genuine `role: "tool"` message correctly on
  its own (verified the same way, 3/3 across repeated tries), so this runs
  with `OLLAMA_TOOL_RESULT_SHIM=false` and confirms that holds through the
  real agent loop, not just in isolated probes. `qwen3.5` also has a
  "thinking" mode that defaults to *on* and is much slower - `run_agent`
  passes `think: false` unconditionally on the `"ollama"` branch (verified
  harmless for models with no such mode, like `llama3.1`).

See `ollama_tool_result_shim.rs`'s doc comment for the full mechanism and
why it's a transport-level workaround rather than a `rig` config option,
and don't assume a third model needs (or doesn't need) either setting
without checking the same way - a model's own advertised "tools" capability
tag isn't a reliable signal on its own (`qwen2.5-coder:7b` has it and still
fails outright).

## Notes and limitations

- **Payment-gated marketplace items can't be auto-deployed.** Their release
  artifact is IBE-encrypted to the item's vetKD identity (see
  `backend/backend.did`); only a buyer's own client, after `set_user_rights`,
  can decrypt it. This agent has no such access and will fall back to writing a
  custom canister instead.
- **There's no PocketIC server binary available by default on an arbitrary
  host**; canister-integration tests that need one will fail regardless of
  correctness unless the host running this server has one installed too -
  `icp build <canister_name>` succeeding (via the subagent's `shell` tool)
  is the real per-canister compile gate its own fix→rebuild loop should key
  off, and `coding_subagent_preamble` (`src/llm/mod.rs`) says so.
- **`scaffold_project`'s real project directory name is the top-level
  agent's requested name plus the job's own id** (its first 8 characters,
  e.g. `todo-list-a1b2c3d4` for a request of `todo-list`) - appended
  automatically by `scaffold_project_tool` (`src/llm/tools.rs`), not
  something the top-level agent has to ask for. `scaffold_project`'s
  response reports this real name back as `project_name`; `PREAMBLE`
  (`src/llm/mod.rs`) tells the agent to use exactly that for every later
  `write_and_compile_project` call, not what it originally typed.
- **`scaffold_project`'s own default canister is always named `backend`**,
  regardless of the job's project name - that's how the `rust` template
  (`icp-cli-templates`) is laid out, not something this agent chose. Only
  applies to that one, first canister; every canister a
  `write_and_compile_project` call with a `canister_name` adds afterward is
  named exactly what it was given.
- **There is no sandbox boundary between LLM-generated code and the host any
  more.** Earlier versions of this server ran every `icp new`/`icp build`/
  `cargo test`/`icp deploy` invocation inside a disposable Docker container,
  which was the actual security boundary - that container is gone. A coding
  subagent's `shell`/`shell_send` tools now run directly with this
  process's own host privileges, filesystem access, and network reach:
  `build.rs`/proc-macros/`#[test]`s already let arbitrary code run during a
  `cargo build`/`cargo test`, and now so does anything typed into a live
  interactive prompt. `read`/`write`/`edit`/`apply_patch`/`glob`/`grep`
  still resolve every path through `codetools::resolve_path` (rejecting an
  absolute path or a `..` component) and every `project_name`/
  `canister_name` is still validated to a strict kebab-case charset before
  being interpolated into a shell command or filesystem path - but these
  are checks against an ordinary mistake or a naive escape attempt, not a
  real security boundary the way the container was. **If isolation matters
  for your deployment, provide it around the orchestrator process itself**
  (a dedicated low-privilege OS user, a VM, or a container wrapping the
  whole server - not just the old build step) rather than assuming one
  exists inside this codebase, because none does.
- **The interactive `shell`/`shell_send` mechanism (`process::InteractiveSessions`)
  has been verified for real against the actual `icp` CLI**, not just a
  synthetic stand-in: a real `icp new` run without `-s` was driven end to
  end through this exact code path - its `Select` prompt ("Use the default
  network or a dockerized one?") was correctly detected as
  `waiting_for_input: true`, and a `shell_send` reply drove it to a genuine,
  complete project generation on disk. That real run is also what surfaced
  and fixed a genuine gap in the first version of the "looks like a pending
  prompt" heuristic: a `dialoguer`-style menu's fully-rendered frame *does*
  end in a trailing newline (unlike a plain line prompt), which is why the
  cursor-hide/-show ANSI signal exists as a second, independent check - see
  `process::looks_like_a_pending_prompt`'s doc comment. What has *not* been
  verified end to end is a full live orchestrator job driving this itself
  through its own tool-calling loop across several building blocks plus a
  real `icp deploy -e ic` - that remains only verified at the level of the
  individual `icp` command shapes (`icp new --path`/`icp deploy`/`icp
  identity import`/`icp canister call`/`icp canister status -i`), same as
  before this change.
