//! All runtime configuration comes from the environment so the orchestrator can be
//! pointed at different networks / LLM providers / building-block source
//! directories without a rebuild. See `services/orchestrator/README.md` for the full
//! list and defaults.

use candid::Principal;
use std::path::PathBuf;

/// Wraps a secret so `Config`'s derived `Debug` can't ever leak it (e.g. via a
/// stray `{config:?}` in a log line) - `Deref`s to `&str` so call sites read
/// like a plain string everywhere except the one place that needs the actual
/// value.
#[derive(Clone)]
pub struct Redacted(String);

impl std::fmt::Debug for Redacted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

impl std::ops::Deref for Redacted {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl Redacted {
    /// The only way to construct one outside `Config::from_env()` - for a
    /// hardcoded, trusted-at-compile-time value only (a test fixture, or a
    /// dev-only example harness's own well-known test mnemonic - see
    /// `examples/dev_server_with_seed.rs`), never for wrapping arbitrary
    /// caller-/network-supplied input. That distinction, not visibility, is
    /// what keeps "never constructed from arbitrary external input" true in
    /// spirit: `from_env()` remains the only path real request/environment
    /// data can reach this type through.
    pub fn for_test(s: &str) -> Self {
        Redacted(s.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Address the axum server binds to.
    pub bind_addr: String,

    /// Directory each job gets a subdirectory under (bind-mounted into the builder
    /// container). Created if missing.
    pub workspace_root: PathBuf,

    /// The canister_hub Marketplace backend canister (see `backend/backend.did`).
    pub marketplace_canister_id: Principal,

    /// The semantic-search index canister (see `hnsw_index/`).
    pub hnsw_canister_id: Principal,

    /// How many nearest neighbours `search_marketplace` asks `hnsw_index` for.
    pub search_top_k: u32,

    /// Cosine-distance cutoff (0 = identical, 1 = orthogonal, 2 = opposite) above
    /// which a search result is treated as "not actually relevant" and dropped -
    /// this is what makes an empty result set mean "no good match" (leading the
    /// orchestration agent to write a custom canister instead) rather than
    /// always returning the closest few vectors no matter how unrelated.
    pub search_relevance_threshold: f32,

    /// Replica URL used when `network == "local"` (a local replica / icp-cli managed
    /// network / PocketIC server). Its root key is untrusted and fetched at startup.
    pub ic_url_local: String,

    /// Replica URL used when `network == "ic"` (mainnet).
    pub ic_url_mainnet: String,

    /// BIP-39 seed phrase to derive the orchestrator's identity from, the same
    /// way `dfx identity new` derives a seed-phrase identity - see
    /// `ic::agent::identity_from_seed_phrase`. Takes priority over
    /// `deploy_identity_pem` when both are set. Treat this like a private key:
    /// it deterministically *is* one.
    pub identity_seed_phrase: Option<Redacted>,

    /// PEM file (Secp256k1 or Ed25519, e.g. a `dfx identity export`) used as the
    /// orchestrator's identity if `identity_seed_phrase` isn't set. One of the
    /// two is required for essentially everything this server does, including
    /// read-only marketplace search (`hnsw_index`'s collection access is
    /// per-identity - see `hnsw_index/README.md`).
    pub deploy_identity_pem: Option<PathBuf>,

    /// Cycles wallet canister id used to fund + create canisters on mainnet (dfx's
    /// standard `wallet_create_canister` flow - see src/ic/deploy.rs). Not needed for
    /// `network == "local"`, which uses the replica's provisional cycles instead.
    pub cycles_wallet_canister_id: Option<Principal>,

    /// Cycles attached to a newly created canister.
    pub canister_creation_cycles: u128,

    /// Wall-clock timeout for any single one-shot command (scaffold / build /
    /// test / `icp canister id`) - see `process::run`. An interactive
    /// `shell`/`shell_send` call uses this as its own hard cap too (see
    /// `shell_idle_timeout_secs`).
    pub command_timeout_secs: u64,

    /// How long an interactive `shell`/`shell_send` session (see
    /// `process::InteractiveSessions`) can go with no new output, while the
    /// output collected so far doesn't end in a newline, before it's
    /// reported back to the coding subagent as "probably waiting on input"
    /// rather than kept waiting - see `process::pump`'s doc comment for why
    /// both conditions (idle *and* no trailing newline) are required
    /// together. Generous by default (a real prompt is idle almost
    /// instantly; this mostly exists to avoid ever mistaking it for one).
    pub shell_idle_timeout_secs: u64,

    /// Directory the coding subagent copies known-good "building block"
    /// canister source from, via `icp new <name> --path <building_blocks_dir>/<kind> ...`
    /// (see `coding_subagent_preamble`). Commands run directly on the host
    /// now, so this just points at this repo's own `packages/` checkout -
    /// nothing needs to be baked into an image ahead of time.
    pub building_blocks_dir: PathBuf,

    /// Which rig provider to use: "openai" | "anthropic" | "gemini" | "ollama" | "deepseek".
    pub llm_provider: String,

    /// Overrides the provider's default model name.
    pub llm_model: Option<String>,

    /// Upper bound on the top-level orchestration agent's internal
    /// tool-calling turns per /orchestrate request.
    pub llm_max_turns: u64,

    /// Upper bound on the coding subagent's own internal tool-calling turns
    /// per `write_and_compile_project` call (its own write/build/fix loop -
    /// independent of, and typically smaller than, `llm_max_turns`).
    pub llm_subagent_max_turns: u64,

    /// How long a coding subagent's `ask_user` tool call waits for a human
    /// to answer (via `POST /jobs/:id/answer`) before giving up and letting
    /// the subagent's own loop continue on its own judgment - see
    /// `llm/codetools.rs::ask_user_tool`. Generous by default: unlike every
    /// other timeout in this config, the thing being waited on here is a
    /// person, not a network call or a compiler.
    pub ask_user_timeout_secs: u64,

    /// Only meaningful when `llm_provider == "ollama"`: whether to rewrite
    /// `role: "tool"` messages to `role: "user"` before sending them to the
    /// local model - see `llm/ollama_tool_result_shim.rs`'s doc comment for
    /// why. Defaults to on, since it's required for every local model
    /// verified so far *except* the `qwen3`/`qwen3.5` family, which handles
    /// the real `tool` role correctly on its own - set this to `false` for
    /// one of those (or any other model you've verified doesn't need the
    /// workaround) so its conversation history matches what it actually
    /// received.
    pub ollama_tool_result_shim: bool,

    /// Template repo `icp new` scaffolds from.
    pub icp_template_git: String,

    /// Subfolder within that repo (the `rust` single-canister template).
    pub icp_template_subfolder: String,

    /// Whether `/orchestrate` and `/jobs/:id` require a valid
    /// `Authorization: Bearer <jwt>` (issued by `backend`'s `issue_jwt` to an
    /// Internet Identity-authenticated caller - see `src/auth.rs`). Defaults
    /// to on; set to `false` only for local development without an II setup,
    /// since disabling it means anyone who can reach this server can trigger
    /// canister creation and cycle spend.
    pub require_auth: bool,

    /// Which replica hosts `marketplace_canister_id`'s `backend` for the
    /// one-time `get_jwt_signing_key` fetch at startup: `"local"` | `"ic"`.
    /// Independent of any given job's own `network` field - this only picks
    /// which URL to bootstrap trust from.
    pub auth_network: String,

    /// GitHub OAuth App client id/secret backing the dashboard's "Connect
    /// Git" flow (see `src/github.rs`) - `register_repo_publisher` is
    /// controller-only (see `backend/src/lib.rs`'s doc comment on it), so
    /// this is the only path left that creates a `REPO_OWNERS` binding, and
    /// it does so only after confirming via GitHub's own API that the
    /// OAuth-authenticated account actually administers the claimed repo.
    /// `None` iff either is unset - the `/github/connect/*` routes return a
    /// clear 500 rather than failing orchestrator startup entirely, since a
    /// deployment that doesn't need marketplace publishing shouldn't need
    /// to configure this.
    pub github_oauth_client_id: Option<String>,
    pub github_oauth_client_secret: Option<Redacted>,

    /// This orchestrator's own externally-reachable base URL (e.g.
    /// `https://orchestrator.example.com`, no trailing slash) - used to
    /// build the GitHub OAuth `redirect_uri`
    /// (`{public_base_url}/github/connect/callback`), which must match
    /// whatever callback URL the GitHub OAuth App itself is configured
    /// with. Required (alongside the two above) only to use "Connect Git".
    pub public_base_url: Option<String>,

    /// Optional GitHub token (a fine-grained PAT with read-only
    /// "Attestations" repository permission is enough) used to call
    /// `GET /repos/{owner}/{repo}/attestations/{digest}` in
    /// `src/provenance.rs`. Unrelated to the OAuth App above - this just
    /// authenticates one read-only API call. `None` sends that request
    /// unauthenticated, which GitHub still serves for public repositories,
    /// just at a much lower rate limit.
    pub github_api_token: Option<Redacted>,

    /// This server's VAPID keypair for Web Push (see `src/push.rs`),
    /// base64url (no padding) encoded - the standard VAPID key format, what
    /// `examples/generate_vapid_keys.rs` prints. `None` iff either is unset:
    /// the `/push/*` routes then return a clear "not configured" error
    /// rather than failing startup, since most deployments won't need this.
    /// Regenerating these invalidates every subscription collected under
    /// the old public key (the browser subscribed against that specific
    /// key), so once set, treat this like any other long-lived credential -
    /// not something to rotate casually.
    pub vapid_public_key: Option<String>,
    pub vapid_private_key: Option<Redacted>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let marketplace_canister_id = std::env::var("MARKETPLACE_CANISTER_ID")
            .map_err(|_| anyhow::anyhow!("MARKETPLACE_CANISTER_ID must be set (the canister_hub backend's canister id)"))?;
        let marketplace_canister_id = Principal::from_text(marketplace_canister_id.trim())
            .map_err(|e| anyhow::anyhow!("MARKETPLACE_CANISTER_ID is not a valid principal: {e}"))?;

        let hnsw_canister_id = std::env::var("HNSW_CANISTER_ID")
            .map_err(|_| anyhow::anyhow!("HNSW_CANISTER_ID must be set (the hnsw_index canister's id)"))?;
        let hnsw_canister_id = Principal::from_text(hnsw_canister_id.trim())
            .map_err(|e| anyhow::anyhow!("HNSW_CANISTER_ID is not a valid principal: {e}"))?;

        let search_top_k: u32 = env_or("SEARCH_TOP_K", "5")
            .parse()
            .map_err(|_| anyhow::anyhow!("SEARCH_TOP_K must be a u32"))?;

        let search_relevance_threshold: f32 = env_or("SEARCH_RELEVANCE_THRESHOLD", "0.4")
            .parse()
            .map_err(|_| anyhow::anyhow!("SEARCH_RELEVANCE_THRESHOLD must be an f32"))?;

        let cycles_wallet_canister_id = match std::env::var("CYCLES_WALLET_CANISTER_ID") {
            Ok(v) if !v.trim().is_empty() => Some(
                Principal::from_text(v.trim())
                    .map_err(|e| anyhow::anyhow!("CYCLES_WALLET_CANISTER_ID is not a valid principal: {e}"))?,
            ),
            _ => None,
        };

        let canister_creation_cycles: u128 = env_or("CANISTER_CREATION_CYCLES", "3000000000000")
            .parse()
            .map_err(|_| anyhow::anyhow!("CANISTER_CREATION_CYCLES must be a u128"))?;

        let command_timeout_secs: u64 = env_or("COMMAND_TIMEOUT_SECS", "600")
            .parse()
            .map_err(|_| anyhow::anyhow!("COMMAND_TIMEOUT_SECS must be a u64"))?;

        let shell_idle_timeout_secs: u64 = env_or("SHELL_IDLE_TIMEOUT_SECS", "20")
            .parse()
            .map_err(|_| anyhow::anyhow!("SHELL_IDLE_TIMEOUT_SECS must be a u64"))?;

        let llm_max_turns: u64 = env_or("LLM_MAX_TURNS", "24")
            .parse()
            .map_err(|_| anyhow::anyhow!("LLM_MAX_TURNS must be a u64"))?;

        let llm_subagent_max_turns: u64 = env_or("LLM_SUBAGENT_MAX_TURNS", "12")
            .parse()
            .map_err(|_| anyhow::anyhow!("LLM_SUBAGENT_MAX_TURNS must be a u64"))?;

        let ask_user_timeout_secs: u64 = env_or("ASK_USER_TIMEOUT_SECS", "1800")
            .parse()
            .map_err(|_| anyhow::anyhow!("ASK_USER_TIMEOUT_SECS must be a u64"))?;

        let ollama_tool_result_shim: bool = env_or("OLLAMA_TOOL_RESULT_SHIM", "true")
            .parse()
            .map_err(|_| anyhow::anyhow!("OLLAMA_TOOL_RESULT_SHIM must be \"true\" or \"false\""))?;

        let require_auth: bool = env_or("REQUIRE_AUTH", "true")
            .parse()
            .map_err(|_| anyhow::anyhow!("REQUIRE_AUTH must be \"true\" or \"false\""))?;

        Ok(Self {
            bind_addr: env_or("BIND_ADDR", "0.0.0.0:8787"),
            workspace_root: PathBuf::from(env_or("WORKSPACE_ROOT", "./data/jobs")),
            marketplace_canister_id,
            hnsw_canister_id,
            search_top_k,
            search_relevance_threshold,
            ic_url_local: env_or("IC_URL_LOCAL", "http://127.0.0.1:4943"),
            ic_url_mainnet: env_or("IC_URL_MAINNET", "https://ic0.app"),
            identity_seed_phrase: std::env::var("IDENTITY_SEED_PHRASE")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(Redacted),
            deploy_identity_pem: std::env::var("DEPLOY_IDENTITY_PEM").ok().map(PathBuf::from),
            cycles_wallet_canister_id,
            canister_creation_cycles,
            command_timeout_secs,
            shell_idle_timeout_secs,
            // Two independent real bugs fixed here, both only surfaced by
            // `routes::database::deploy_database`'s first real end-to-end
            // test (the automated coding subagent pipeline had never once
            // gotten far enough in a real run to exercise this exact
            // command for real):
            //
            // 1. The default itself was wrong: `packages/` is a sibling of
            //    this crate (`services/orchestrator/`), not nested inside it (this
            //    repo's real, unchanging layout) - `../packages`, not
            //    `./packages`, is what actually points at it when this
            //    process's own cwd is the crate root (the normal way to
            //    run it).
            // 2. Whatever the value, it must be absolutized relative to
            //    *this process's own* cwd at startup (`std::path::absolute` -
            //    lexical, no symlink resolution, doesn't require the path
            //    to exist yet): every `icp new --path {building_blocks_dir}/<kind>`
            //    command runs with its *shell's* cwd set to a job's own
            //    project directory (`workspace/<job>/<project>`), so a
            //    relative value would resolve relative to that project
            //    directory instead - "nested inside the project", never
            //    the real one.
            building_blocks_dir: {
                let raw = PathBuf::from(env_or("BUILDING_BLOCKS_DIR", "../packages"));
                std::path::absolute(&raw).unwrap_or(raw)
            },
            llm_provider: env_or("LLM_PROVIDER", "openai"),
            llm_model: std::env::var("LLM_MODEL").ok(),
            llm_max_turns,
            llm_subagent_max_turns,
            ask_user_timeout_secs,
            ollama_tool_result_shim,
            icp_template_git: env_or("ICP_TEMPLATE_GIT", "https://github.com/dfinity/icp-cli-templates"),
            icp_template_subfolder: env_or("ICP_TEMPLATE_SUBFOLDER", "rust"),
            require_auth,
            auth_network: env_or("AUTH_NETWORK", "local"),
            github_oauth_client_id: std::env::var("GITHUB_OAUTH_CLIENT_ID")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            github_oauth_client_secret: std::env::var("GITHUB_OAUTH_CLIENT_SECRET")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(Redacted),
            public_base_url: std::env::var("PUBLIC_BASE_URL")
                .ok()
                .map(|v| v.trim().trim_end_matches('/').to_string())
                .filter(|v| !v.is_empty()),
            github_api_token: std::env::var("GITHUB_API_TOKEN")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(Redacted),
            vapid_public_key: std::env::var("VAPID_PUBLIC_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            vapid_private_key: std::env::var("VAPID_PRIVATE_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(Redacted),
        })
    }
}
