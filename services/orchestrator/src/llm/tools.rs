//! The tools the Orchestration Agent can call. Each one wraps a step of the
//! pipeline described in `services/orchestrator/README.md`: search the Marketplace, either
//! deploy a prebuilt item directly, or decompose the request into building
//! blocks, assemble them into one multi-canister project, and deploy that
//! project for real. The LLM decides which tools to call and in what order/
//! how many times (e.g. calling write_and_compile_project once per building
//! block, then once more to deploy) - this module only implements what each
//! tool *does*, not the plan (see `src/llm/mod.rs`'s `PREAMBLE` for that).

use crate::config::Config;
use crate::ic::{
    deploy, marketplace,
    types::{MarketplaceItem, MarketplaceItemType},
};
use crate::job::{JobHandle, JobStore};
use crate::process;
use crate::provenance;
use candid::Principal;
use ic_agent::Agent as IcAgent;
use rig::tool::{DynamicTool, ToolContext, ToolExecutionError, ToolOutput};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Cap on a downloaded marketplace release artifact, to stop a malicious/broken
/// a manifest-resolved release download from exhausting disk/memory.
const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;

pub struct JobContext {
    pub job: JobHandle,
    /// Needed only for `ask_user_tool` (`llm/codetools.rs`) - registering/
    /// clearing this job's pending-answer channel goes through the store,
    /// not the job handle itself, since the channel's sender half can't
    /// live on `Job` (see `job.rs`'s doc comment on `JobStore`).
    pub jobs: JobStore,
    pub config: Arc<Config>,
    pub ic_agent: Arc<IcAgent>,
    pub http: reqwest::Client,
    pub caller_principal: Principal,
    pub network: String,
    /// The coding subagent's own `shell`/`shell_send` tools' currently-open
    /// interactive command sessions (see `process::InteractiveSessions`) -
    /// scoped to this job, closed out explicitly at the end of every
    /// `write_and_compile_project` call rather than relying on any
    /// container-style auto-cleanup (there isn't one, now that commands run
    /// directly on the host).
    pub interactive_sessions: process::InteractiveSessions,
    marketplace_cache: Mutex<Option<Vec<MarketplaceItem>>>,
}

impl JobContext {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        job: JobHandle,
        jobs: JobStore,
        config: Arc<Config>,
        ic_agent: Arc<IcAgent>,
        caller_principal: Principal,
        network: String,
    ) -> Self {
        Self {
            job,
            jobs,
            config,
            ic_agent,
            http: reqwest::Client::new(),
            caller_principal,
            network,
            interactive_sessions: process::InteractiveSessions::default(),
            marketplace_cache: Mutex::new(None),
        }
    }

    pub(crate) fn log(&self, tool: &str, detail: impl Into<String>) {
        self.job.lock().unwrap().push_log(tool, detail);
    }

    pub(crate) fn workspace_dir(&self) -> PathBuf {
        self.job.lock().unwrap().workspace_dir.clone()
    }

    pub(crate) fn job_id(&self) -> String {
        self.job.lock().unwrap().id.clone()
    }

    async fn marketplace_items(&self) -> anyhow::Result<Vec<MarketplaceItem>> {
        {
            let cache = self.marketplace_cache.lock().unwrap();
            if let Some(items) = cache.as_ref() {
                return Ok(items.clone());
            }
        }
        let items = marketplace::list_marketplace_items(
            &self.ic_agent,
            self.config.marketplace_canister_id,
        )
        .await?;
        *self.marketplace_cache.lock().unwrap() = Some(items.clone());
        Ok(items)
    }
}

pub(crate) fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, ToolExecutionError> {
    serde_json::from_value(args)
        .map_err(|e| ToolExecutionError::invalid_args(format!("bad arguments: {e}")).with_source(e))
}

/// icp-cli project names and our own path segments end up interpolated into a
/// shell string run inside the builder container - keep this to the same
/// characters `icp new` itself accepts (kebab-case) so nothing can break out of
/// the intended command.
fn sanitize_project_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name.chars().next().unwrap().is_ascii_lowercase()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(name.to_string())
    } else {
        Err(format!(
            "invalid project_name '{name}': must be kebab-case (lowercase letters, digits, hyphens), starting with a letter"
        ))
    }
}

pub(crate) fn err_json(message: impl Into<String>) -> ToolOutput {
    ToolOutput::json(json!({ "success": false, "error": message.into() }))
}

/// Tools for the top-level Orchestration Agent. Note `codetools.rs`'s own
/// tools (`read`/`write`/`edit`/`shell`/etc.) aren't in this list - they're
/// the coding subagent's (see `write_and_compile_project_tool`), not the
/// top-level agent's. Giving the top-level agent both sets would let it
/// bypass the subagent and iterate compiler errors/`icp` commands itself,
/// defeating the point of delegating that loop out of its turn budget.
///
/// `ask_user` (defined in `codetools.rs`, alongside the coding subagent's
/// own toolset) is included here too - without it, a request too vague to
/// break into building blocks could only be answered with plain text and no
/// tool call, which `pipeline::run` correctly (but unhelpfully) records as a
/// failure rather than a paused, answerable conversation. See `PREAMBLE`
/// below for the matching instruction to actually use it.
pub fn build_tools(ctx: Arc<JobContext>) -> Vec<DynamicTool> {
    vec![
        search_marketplace_tool(ctx.clone()),
        deploy_marketplace_item_tool(ctx.clone()),
        scaffold_project_tool(ctx.clone()),
        write_and_compile_project_tool(ctx.clone()),
        crate::llm::codetools::ask_user_tool(ctx),
    ]
}

// ---------------------------------------------------------------------------
// 1. search_marketplace
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
}

fn search_marketplace_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "search_marketplace",
        "Semantically search the canister_hub Marketplace for an already-published \
         canister that might satisfy the user's request. Always try this before \
         writing new code - reusing a published canister is strictly cheaper. \
         Embeds the query and finds the closest indexed item descriptions, so \
         describe the desired *functionality* in a sentence or two rather than \
         just keywords. An empty result means nothing indexed is a close enough \
         match - that's the signal to write a custom canister instead of a reason \
         to retry with different wording. Returns candidates ranked closest-match \
         first (ties broken by download count) with their id, title, description, \
         price, whether they're payment-gated, and git_repo_url.",
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A sentence or two describing the desired canister's functionality"
                }
            },
            "required": ["query"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let args: SearchArgs = parse_args(args)?;
                let matches = match semantic_search(&ctx, &args.query).await {
                    Ok(matches) => matches,
                    Err(e) => {
                        ctx.log("search_marketplace", format!("search failed: {e}"));
                        return Ok(err_json(format!("marketplace search failed: {e}")));
                    }
                };
                let results: Vec<Value> = matches
                    .iter()
                    .map(|(item, distance)| {
                        json!({
                            "id": item.id,
                            "title": item.title,
                            "description": item.description.chars().take(300).collect::<String>(),
                            "price": item.price,
                            "gated": item.is_gated(),
                            "git_repo_url": item.git_repo_url,
                            "downloads": item.downloads,
                            "distance": distance,
                        })
                    })
                    .collect();
                ctx.log(
                    "search_marketplace",
                    format!(
                        "query={:?} -> {} relevant match(es)",
                        args.query,
                        results.len()
                    ),
                );
                Ok(ToolOutput::json(
                    json!({ "success": true, "matches": results }),
                ))
            })
        },
    )
}

/// Embeds `query`, searches `hnsw_index`, drops anything past
/// `search_relevance_threshold`, resolves the survivors back to full
/// `MarketplaceItem`s, and ranks them closest-distance-first with download
/// count as the tie-break - exactly the "closest, then most popular" rule
/// this tool's callers are told to expect.
async fn semantic_search(
    ctx: &JobContext,
    query: &str,
) -> anyhow::Result<Vec<(MarketplaceItem, f32)>> {
    let embedding = crate::embeddings::embed_text(query).await?;

    let req = crate::ic::hnsw::SearchRequest {
        collection_id: crate::ic::hnsw::MARKETPLACE_ITEMS_COLLECTION_ID,
        vector: embedding,
        top_k: ctx.config.search_top_k,
        ef_search: (ctx.config.search_top_k * 4).max(ctx.config.search_top_k),
        distance: None,
    };
    let results = crate::ic::hnsw::search(&ctx.ic_agent, ctx.config.hnsw_canister_id, req).await?;

    let items = ctx.marketplace_items().await?;
    let mut matches: Vec<(MarketplaceItem, f32)> = results
        .into_iter()
        .filter(|r| r.distance <= ctx.config.search_relevance_threshold)
        .filter_map(|r| {
            let item_id = crate::ic::hnsw::metadata_to_item_id(&r.metadata)?;
            let item = items.iter().find(|i| i.id == item_id)?.clone();
            Some((item, r.distance))
        })
        .collect();

    // hnsw_index already returns closest-first, but the id/downloads join
    // above doesn't preserve that - re-sort explicitly rather than rely on it.
    matches.sort_by(|(item_a, dist_a), (item_b, dist_b)| {
        dist_a
            .partial_cmp(dist_b)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| item_b.downloads.cmp(&item_a.downloads))
    });
    Ok(matches)
}

// ---------------------------------------------------------------------------
// 2. deploy_marketplace_item
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DeployMarketplaceItemArgs {
    item_id: u64,
}

#[derive(Deserialize)]
struct PackageManifest {
    schema_version: u32,
    package: PackageManifestEntry,
}

#[derive(Deserialize)]
struct PackageManifestEntry {
    wasm_url: String,
}

fn deploy_marketplace_item_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "deploy_marketplace_item",
        "Download a free (non payment-gated) marketplace item's prebuilt wasm and \
         deploy it as a fresh canister. Fails if the item is payment-gated (its \
         release artifact is encrypted and only a paying buyer's client can decrypt \
         it) - in that case fall back to writing a custom canister instead.",
        json!({
            "type": "object",
            "properties": {
                "item_id": { "type": "integer", "description": "Marketplace item id, from search_marketplace" }
            },
            "required": ["item_id"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let args: DeployMarketplaceItemArgs = parse_args(args)?;

                let items = match ctx.marketplace_items().await {
                    Ok(items) => items,
                    Err(e) => {
                        return Ok(err_json(format!(
                            "failed to query the marketplace canister: {e}"
                        )))
                    }
                };
                let Some(item) = items.into_iter().find(|i| i.id == args.item_id) else {
                    return Ok(err_json(format!(
                        "no marketplace item with id {}",
                        args.item_id
                    )));
                };
                if item.item_type != MarketplaceItemType::Package {
                    return Ok(err_json(format!(
                        "item {} ('{}') is a template, not an installable package",
                        item.id, item.title
                    )));
                }
                if item.is_gated() {
                    return Ok(err_json(format!(
                        "item {} ('{}') is payment-gated - its release artifact is IBE-encrypted and this agent \
                         has no vetKD buyer access to decrypt it. Write a custom canister instead.",
                        item.id, item.title
                    )));
                }

                ctx.log(
                    "deploy_marketplace_item",
                    format!("downloading manifest {}", item.download_url),
                );
                let manifest_bytes = match download_wasm(&ctx.http, &item.download_url).await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        return Ok(err_json(format!(
                            "failed to download canister_hub.toml: {e}"
                        )))
                    }
                };
                let manifest: PackageManifest = match std::str::from_utf8(&manifest_bytes)
                    .map_err(anyhow::Error::from)
                    .and_then(|text| {
                        toml::from_str::<PackageManifest>(text).map_err(anyhow::Error::from)
                    }) {
                    Ok(manifest) if manifest.schema_version == 1 => manifest,
                    Ok(_) => return Ok(err_json("unsupported package manifest schema_version")),
                    Err(e) => {
                        return Ok(err_json(format!("invalid package canister_hub.toml: {e}")))
                    }
                };
                if !(manifest.package.wasm_url.starts_with("https://")
                    || manifest.package.wasm_url.starts_with("http://"))
                {
                    return Ok(err_json("package.wasm_url must be absolute HTTP(S)"));
                }
                let wasm = match download_wasm(&ctx.http, &manifest.package.wasm_url).await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        return Ok(err_json(format!(
                            "failed to download release artifact: {e}"
                        )))
                    }
                };
                if let Err(e) = verify_wasm_hash(&wasm, &item.wasm_hash) {
                    return Ok(err_json(format!(
                        "refusing to install item {} ('{}'): {e}",
                        item.id, item.title
                    )));
                }
                if let Err(e) =
                    provenance::verify_build_provenance(&ctx.config, &item.git_repo_url, &wasm)
                        .await
                {
                    return Ok(err_json(format!(
                        "refusing to install item {} ('{}'): {e}",
                        item.id, item.title
                    )));
                }

                match run_deploy(&ctx, &wasm).await {
                    Ok(canister_id) => {
                        let final_message = format!(
                            "Deployed marketplace item {} ('{}') as {canister_id}",
                            item.id, item.title
                        );
                        ctx.job
                            .lock()
                            .unwrap()
                            .succeed(Some(canister_id.to_string()), final_message.clone());
                        ctx.log(
                            "deploy_marketplace_item",
                            format!("deployed as {canister_id}"),
                        );
                        // No `backend` write here - see the
                        // `decouple-orchestrator-api` project notes.
                        // Best-effort popularity bump - a failure here shouldn't
                        // undo an otherwise-successful deploy.
                        if let Err(e) = marketplace::record_download(
                            &ctx.ic_agent,
                            ctx.config.marketplace_canister_id,
                            item.id,
                        )
                        .await
                        {
                            ctx.log(
                                "deploy_marketplace_item",
                                format!("record_download failed (non-fatal): {e}"),
                            );
                        }
                        Ok(ToolOutput::json(
                            json!({ "success": true, "canister_id": canister_id.to_string() }),
                        ))
                    }
                    Err(e) => {
                        ctx.log("deploy_marketplace_item", format!("deploy failed: {e}"));
                        Ok(err_json(format!("deploy failed: {e}")))
                    }
                }
            })
        },
    )
}

async fn download_wasm(http: &reqwest::Client, url: &str) -> anyhow::Result<Vec<u8>> {
    let response = http.get(url).send().await?.error_for_status()?;
    if let Some(len) = response.content_length() {
        if len as usize > MAX_DOWNLOAD_BYTES {
            anyhow::bail!(
                "release artifact is {len} bytes, over the {MAX_DOWNLOAD_BYTES}-byte limit"
            );
        }
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        anyhow::bail!(
            "release artifact is {} bytes, over the {MAX_DOWNLOAD_BYTES}-byte limit",
            bytes.len()
        );
    }
    Ok(bytes.to_vec())
}

/// Confirms the just-downloaded release artifact is byte-for-byte what the
/// verified publisher recorded on-chain at publish time. The manifest and
/// the GitHub Release asset it points `wasm_url` at are both off-chain and
/// publisher-mutable *after* publishing (a release asset can be swapped
/// without changing its URL) - `MarketplaceItem::wasm_hash` is the one part
/// of this install path that can't be, so every install must check the
/// downloaded bytes against it before ever being deployed.
fn verify_wasm_hash(wasm: &[u8], expected_hash: &[u8]) -> anyhow::Result<()> {
    let actual_hash: [u8; 32] = Sha256::digest(wasm).into();
    if actual_hash != expected_hash {
        anyhow::bail!(
            "downloaded release artifact's sha256 does not match this item's recorded wasm_hash \
             - the manifest or release asset may have been swapped after publishing"
        );
    }
    Ok(())
}

async fn run_deploy(ctx: &JobContext, wasm: &[u8]) -> anyhow::Result<Principal> {
    let outcome = if ctx.network == "ic" {
        let wallet_id = ctx.config.cycles_wallet_canister_id.ok_or_else(|| {
            anyhow::anyhow!(
                "CYCLES_WALLET_CANISTER_ID is not configured - required to deploy to mainnet"
            )
        })?;
        deploy::create_and_install_mainnet(
            &ctx.ic_agent,
            wallet_id,
            ctx.caller_principal,
            ctx.config.canister_creation_cycles,
            wasm,
        )
        .await?
    } else {
        // `marketplace_canister_id` is just a real, already-known canister id
        // to route this call's certificate verification through - see
        // `deploy::create_and_install_local`'s doc comment - not otherwise
        // related to the marketplace.
        deploy::create_and_install_local(
            &ctx.ic_agent,
            ctx.caller_principal,
            ctx.config.canister_creation_cycles,
            wasm,
            ctx.config.marketplace_canister_id,
        )
        .await?
    };
    Ok(outcome.canister_id)
}

// ---------------------------------------------------------------------------
// 3. scaffold_project
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ScaffoldArgs {
    project_name: String,
}

fn scaffold_project_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "scaffold_project",
        "Create a new ICP project from the standard Rust template - the multi-canister \
         project every subsequent write_and_compile_project call for this request adds \
         building blocks to. \
         Call this ONCE per request, before any write_and_compile_project call. \
         The actual project directory this creates is your requested name plus this \
         job's own id, e.g. 'todo-list-a1b2c3d4' for a request of 'todo-list' - the \
         response's project_name is the real name; use exactly that (not what you \
         requested) for every later write_and_compile_project call. \
         Returns the generated default canister's src/lib.rs, Cargo.toml, and .did \
         file contents so you know what you're overwriting if you customize it.",
        json!({
            "type": "object",
            "properties": {
                "project_name": {
                    "type": "string",
                    "description": "kebab-case name for the project directory, e.g. 'todo-list' - this job's own id is appended automatically to keep it unique"
                }
            },
            "required": ["project_name"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let args: ScaffoldArgs = parse_args(args)?;
                let requested_name = match sanitize_project_name(&args.project_name) {
                    Ok(n) => n,
                    Err(e) => return Ok(err_json(e)),
                };
                // Traceable back to the job that produced it, and unique even
                // if the same request name gets picked twice (unlikely to
                // collide within a job's own workspace anyway, since each
                // job already has its own directory - this is about the
                // project name itself carrying its origin, not about
                // preventing an on-disk clash). The job id is always a
                // `Uuid::new_v4()` string (see `routes/orchestrate.rs`), so
                // its first 8 characters are always plain hex - safe to
                // interpolate without re-sanitizing.
                let short_job_id: String = ctx.job_id().chars().take(8).collect();
                let name = format!("{requested_name}-{short_job_id}");

                let workspace = ctx.workspace_dir();
                if workspace.join(&name).exists() {
                    return Ok(err_json(format!(
                        "project '{name}' already exists in this job's workspace"
                    )));
                }

                let command = format!(
                    "icp new {name} --git {} --subfolder {} -s --define network_type=Default 2>&1",
                    ctx.config.icp_template_git, ctx.config.icp_template_subfolder
                );
                let timeout = Duration::from_secs(ctx.config.command_timeout_secs);
                let result = match process::run(&workspace, &command, timeout).await {
                    Ok(r) => r,
                    Err(e) => {
                        ctx.log("scaffold_project", format!("exec failed: {e}"));
                        return Ok(err_json(format!("failed to run icp-cli: {e}")));
                    }
                };
                let log_tail = result.combined_tail(4000);
                ctx.log(
                    "scaffold_project",
                    format!("name={name} success={} \n{log_tail}", result.success),
                );

                if !result.success {
                    return Ok(ToolOutput::json(json!({
                        "success": false,
                        "error": "icp new failed",
                        "log": log_tail,
                    })));
                }

                let project_dir = workspace.join(&name);
                let lib_rs = read_file_lossy(&project_dir.join("src/lib.rs"));
                let cargo_toml = read_file_lossy(&project_dir.join("Cargo.toml"));
                let did_file = find_did_file(&project_dir);
                let did_contents = did_file
                    .as_ref()
                    .map(|p| read_file_lossy(p))
                    .unwrap_or_default();

                ctx.job.lock().unwrap().set_project_name(name.clone());
                // No `backend` write here - see the
                // `decouple-orchestrator-api` project notes.

                Ok(ToolOutput::json(json!({
                    "success": true,
                    "project_name": name,
                    "lib_rs": lib_rs,
                    "cargo_toml": cargo_toml,
                    "did_contents": did_contents,
                    "note": "the in-project canister is always named 'backend' regardless of project_name",
                })))
            })
        },
    )
}

fn read_file_lossy(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn find_did_file(project_dir: &std::path::Path) -> Option<PathBuf> {
    std::fs::read_dir(project_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("did"))
}

// ---------------------------------------------------------------------------
// 4. write_and_compile_project
//
// The top-level agent's only tool for actually assembling a project. It
// delegates to a coding subagent - a fresh, separate rig agent
// (`coding_subagent_preamble`) equipped with the `codetools` toolset
// (read/write/edit/apply_patch/glob/grep/shell/shell_send/todowrite/
// ask_user - see `src/llm/codetools.rs`) and its own turn budget
// (`llm_subagent_max_turns`). Commands the subagent runs (via `shell`/
// `shell_send`) execute directly on the host, with a real interactive
// pseudo-terminal available for anything that might prompt - see
// `process::InteractiveSessions`.
//
// The subagent's tools are always scoped to the whole project's root
// (`workspace/{project_name}`) - verified directly that `icp new` refuses to
// generate into a directory that already exists at all, even empty, so
// pre-creating and scoping to a not-yet-existing canister subfolder (the
// obvious-looking design) doesn't work; the project root is the one
// directory guaranteed to exist already (from `scaffold_project`) whether
// this call is about one canister or the whole project. `canister_name`
// (optional) only changes what the *spec* tells the subagent to do - see
// `coding_subagent_preamble`'s own two situations: work on one named
// canister subfolder, or (no canister_name) deploy the whole project for
// real via `icp deploy -e ic` and wire its canisters together.
//
// The top-level agent never sees the subagent's intermediate tool calls or
// compiler/deploy output, only its final summary - and this tool doesn't
// just trust that summary either: with a canister_name, it independently
// checks for a wasm artifact under that canister's own subfolder
// (`process::find_wasm_artifact`); without one, it independently re-queries
// each canister's real deployed id (`icp canister status <name> -i -e ic`,
// parsed from this project's own icp.yaml) rather than trusting the
// subagent's self-reported ids.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WriteAndCompileArgs {
    project_name: String,
    /// Which canister subfolder this call is about - omit only for the
    /// final "deploy and wire the whole project" call (see this module's
    /// doc comment above and `coding_subagent_preamble`'s own two
    /// situations).
    #[serde(default)]
    canister_name: Option<String>,
    spec: String,
}

fn write_and_compile_project_tool(ctx: Arc<JobContext>) -> DynamicTool {
    DynamicTool::new(
        "write_and_compile_project",
        "Delegates one step of assembling a project to a coding subagent. Give it a \
         project_name that's already been scaffolded (via scaffold_project). \
         \n\nTo add or customize ONE canister: also give canister_name (a short \
         kebab-case name for that canister's own subfolder, e.g. \"connector\") and \
         a spec - for a known building block (connector/agent/admin_agent/ \
         a database kind/static/assets) a short note of what it's for is enough, \
         since the subagent adds it from known-good source rather than writing new \
         code; for a genuinely custom canister or agent's own business \
         logic, describe the actual behavior needed. The subagent adds the canister, \
         registers it in the project's icp.yaml, does any genuine customization \
         actually warranted, and writes and runs its tests before reporting back. \
         \n\nOnce every needed canister has been added successfully, call this ONE \
         MORE TIME for the same project WITHOUT canister_name, with a spec describing \
         which canisters need to know about each other (e.g. \"connector needs \
         agent's id; agent needs connector's id back\") - this \
         deploys the whole project for real (mainnet) and wires the pieces together. \
         \n\nYou only see each call's final summary, not its intermediate steps. Call \
         again with a clarified spec if a call reports failure and you want another \
         attempt.",
        json!({
            "type": "object",
            "properties": {
                "project_name": { "type": "string" },
                "canister_name": {
                    "type": "string",
                    "description": "kebab-case subfolder name for the ONE canister this call is about - omit only for the final whole-project deploy+wire call"
                },
                "spec": {
                    "type": "string",
                    "description": "what this call should accomplish - as complete and specific as possible, since the subagent has no other context about the user's request"
                }
            },
            "required": ["project_name", "spec"]
        }),
        move |_ctx: &mut ToolContext, args: Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let args: WriteAndCompileArgs = parse_args(args)?;
                let name = match sanitize_project_name(&args.project_name) {
                    Ok(n) => n,
                    Err(e) => return Ok(err_json(e)),
                };
                let canister_name = match &args.canister_name {
                    Some(n) => match sanitize_project_name(n) {
                        Ok(n) => Some(n),
                        Err(e) => return Ok(err_json(e)),
                    },
                    None => None,
                };
                let workspace = ctx.workspace_dir();
                let project_dir = workspace.join(&name);
                if !project_dir.is_dir() {
                    return Ok(err_json(format!(
                        "project '{name}' doesn't exist - call scaffold_project first"
                    )));
                }

                // Only when deploying the whole project (no canister_name)
                // to real mainnet: the identity `icp deploy`/`icp identity
                // import` (both run by the subagent itself, via shell - see
                // coding_subagent_preamble's own mainnet-only "Import the
                // deploy identity" step) need to find on disk. A `network:
                // "local"` job's own coding_subagent_preamble never
                // mentions an identity file at all - deploying locally
                // succeeds anonymously - so nothing needs to be written for
                // it, and a local job never needs
                // IDENTITY_SEED_PHRASE/DEPLOY_IDENTITY_PEM configured just
                // to reach this step. Written into the project root - the
                // same directory every shell call for this project already
                // runs in - rather than passed any other way. Removed
                // again after this call returns, regardless of outcome, so
                // it never outlives the one call that needs it.
                let identity_file = if canister_name.is_none() && ctx.network == "ic" {
                    match write_deploy_identity_file(&ctx.config, &project_dir) {
                        Ok(path) => Some(path),
                        Err(e) => return Ok(err_json(e)),
                    }
                } else {
                    None
                };

                ctx.log(
                    "write_and_compile_project",
                    format!(
                        "starting coding subagent for '{name}' (canister_name={:?})",
                        canister_name
                    ),
                );
                let read_tracker = Arc::new(crate::llm::codetools::ReadTracker::default());
                let subagent_tools = crate::llm::codetools::build_code_tools(
                    ctx.clone(),
                    project_dir.clone(),
                    read_tracker,
                );
                let max_turns = ctx.config.llm_subagent_max_turns as usize;
                let situation_header = match &canister_name {
                    Some(cname) => format!("You're working on one canister: canister_name = \"{cname}\".\n\n"),
                    None => "You're deploying and wiring the finished project (no canister_name - every canister the project needs is already a subfolder here).\n\n".to_string(),
                };
                let request = format!("{situation_header}{}", args.spec);
                // The original job request - the app's actual business
                // requirements, not this one call's own narrower spec - goes
                // into the subagent's *system* prompt (see
                // `coding_subagent_preamble`'s own doc comment for why),
                // read fresh each call rather than captured once, so it's
                // never stale relative to the job it actually belongs to.
                let business_requirements = ctx.job.lock().unwrap().request.clone();
                let preamble = crate::llm::coding_subagent_preamble(
                    &ctx.config,
                    &business_requirements,
                    &ctx.network,
                );
                let outcome = crate::llm::run_agent(
                    &ctx.config,
                    &preamble,
                    subagent_tools,
                    request,
                    max_turns,
                )
                .await;
                // Recorded before any of the cleanup below, so a real spend
                // is never lost even if something after this panics - see
                // `AgentRunOutcome`'s doc comment for why this is populated
                // regardless of whether the run itself succeeded.
                ctx.job.lock().unwrap().add_usage(outcome.usage);

                if let Some(path) = identity_file {
                    let _ = std::fs::remove_file(&path);
                }
                // No `--rm` container to reap any interactive session this
                // call's subagent left open (see `process::InteractiveSessions`) -
                // close them out explicitly, win or lose, same as the
                // identity file just above.
                ctx.interactive_sessions.close_all();

                match outcome.result {
                    Ok(summary) => {
                        let response = match &canister_name {
                            Some(cname) => {
                                let canister_dir = project_dir.join(cname);
                                let wasm_found =
                                    process::find_wasm_artifact(&canister_dir, cname).is_some();
                                ctx.log("write_and_compile_project", format!("subagent finished for '{name}/{cname}': wasm_found={wasm_found}"));
                                json!({ "success": wasm_found, "summary": summary, "wasm_found": wasm_found })
                            }
                            None => {
                                let canister_ids =
                                    verify_deployed_canister_ids(&ctx, &project_dir).await;
                                ctx.log(
                                    "write_and_compile_project",
                                    format!("subagent finished deploying '{name}': verified {} canister id(s)", canister_ids.len()),
                                );
                                let confirmed: Vec<(String, String)> = canister_ids
                                    .iter()
                                    .filter_map(|(name, id)| {
                                        id.as_str().map(|id| (name.clone(), id.to_string()))
                                    })
                                    .collect();
                                ctx.job
                                    .lock()
                                    .unwrap()
                                    .add_canisters(confirmed.iter().cloned());
                                // Add the real requesting user - proven via the JWT bridge,
                                // never the orchestrator's own deploy identity's principal
                                // (`ctx.caller_principal` is that identity's own principal, not
                                // this - see `process::add_controller`'s own doc comment) - as
                                // an additional controller of every canister this call just
                                // confirmed. Best-effort per canister, same "one failure
                                // doesn't break the rest" convention as everything else here:
                                // the canister is already real and deployed either way, this
                                // only affects who else can administer it afterward.
                                let requested_by = ctx.job.lock().unwrap().requested_by.clone();
                                let is_mainnet = ctx.network == "ic";
                                for (canister_name, _) in &confirmed {
                                    let timeout = std::time::Duration::from_secs(
                                        ctx.config.command_timeout_secs.min(60),
                                    );
                                    match process::add_controller(&project_dir, canister_name, &requested_by, is_mainnet, timeout).await {
                                        Ok(result) if result.success => {}
                                        Ok(result) => ctx.log(
                                            "write_and_compile_project",
                                            format!("failed to add {requested_by} as a controller of '{canister_name}' (non-fatal): {}", result.combined_tail(500)),
                                        ),
                                        Err(e) => ctx.log("write_and_compile_project", format!("failed to add {requested_by} as a controller of '{canister_name}' (non-fatal): {e}")),
                                    }
                                }
                                // No `backend` write here - see the
                                // `decouple-orchestrator-api` project notes.
                                let (project_name, request, network) = {
                                    let job = ctx.job.lock().unwrap();
                                    (
                                        job.project_name.clone().unwrap_or_else(|| job.id.clone()),
                                        job.request.clone(),
                                        job.network.clone(),
                                    )
                                };
                                let llm_context = generate_llm_context(
                                    &project_name,
                                    &request,
                                    &network,
                                    ctx.config.command_timeout_secs,
                                    &project_dir,
                                    &canister_ids,
                                )
                                .await;
                                ctx.job.lock().unwrap().set_llm_context(llm_context.clone());
                                json!({ "success": !canister_ids.is_empty(), "summary": summary, "canister_ids": canister_ids })
                            }
                        };
                        Ok(ToolOutput::json(response))
                    }
                    Err(e) => {
                        ctx.log(
                            "write_and_compile_project",
                            format!("coding subagent errored: {e}"),
                        );
                        Ok(err_json(format!("coding subagent failed to run: {e}")))
                    }
                }
            })
        },
    )
}

/// Writes whichever identity `Config` has configured into `project_dir` as a
/// file `icp identity import` can read directly - a PEM file copied
/// byte-for-byte, or a seed phrase as plain text - matching
/// `coding_subagent_preamble`'s deploy-and-wire instructions for which file
/// to expect and which `icp identity import` flag it pairs with. Returns the path
/// written, for the caller to clean up afterward.
fn write_deploy_identity_file(
    config: &Config,
    project_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if let Some(pem_path) = &config.deploy_identity_pem {
        let dest = project_dir.join(".orchestrator-identity.pem");
        std::fs::copy(pem_path, &dest).map_err(|e| {
            format!("failed to stage the deploy identity PEM into the project: {e}")
        })?;
        return Ok(dest);
    }
    if let Some(seed_phrase) = &config.identity_seed_phrase {
        let dest = project_dir.join(".orchestrator-identity.seed");
        std::fs::write(&dest, seed_phrase.as_bytes()).map_err(|e| {
            format!("failed to stage the deploy identity seed phrase into the project: {e}")
        })?;
        return Ok(dest);
    }
    Err("no identity configured (set IDENTITY_SEED_PHRASE or DEPLOY_IDENTITY_PEM) - deploying requires a real identity".to_string())
}

/// Independently confirms each canister the project's own icp.yaml lists is
/// actually deployed, by running `icp canister status <name> -i -e ic` for
/// each one (verified directly against a real `icp` install - there is no
/// `icp canister id` subcommand, despite this having been assumed
/// otherwise for a while; `status -i`/`--id-only` is the real, correct
/// form and its output is confirmed to be exactly the bare principal text,
/// nothing else) rather than trusting the subagent's own self-reported ids
/// (matching this project's standing "verify, don't trust" pattern - see
/// `process::find_wasm_artifact`'s equivalent role for a single-canister
/// build). Returns a name-to-id JSON object; a canister missing from it
/// means its id couldn't be independently confirmed, whatever the subagent
/// itself may have claimed.
async fn verify_deployed_canister_ids(
    ctx: &JobContext,
    project_dir: &std::path::Path,
) -> serde_json::Map<String, Value> {
    let mut confirmed = serde_json::Map::new();
    let names = match parse_icp_yaml_canister_names(&project_dir.join("icp.yaml")) {
        Ok(names) => names,
        Err(e) => {
            ctx.log(
                "write_and_compile_project",
                format!("could not read this project's icp.yaml to verify canister ids: {e}"),
            );
            return confirmed;
        }
    };

    for name in names {
        let command = format!("icp canister status {name} -i -e ic 2>&1");
        let timeout = Duration::from_secs(ctx.config.command_timeout_secs.min(60));
        let result = match process::run(project_dir, &command, timeout).await {
            Ok(r) => r,
            Err(e) => {
                ctx.log(
                    "write_and_compile_project",
                    format!("failed to verify canister id for '{name}': {e}"),
                );
                continue;
            }
        };
        let id_text = result.stdout.trim();
        if result.success && Principal::from_text(id_text).is_ok() {
            confirmed.insert(name, Value::String(id_text.to_string()));
        } else {
            ctx.log(
                "write_and_compile_project",
                format!(
                    "could not confirm a deployed id for '{name}': {}",
                    result.combined_tail(500)
                ),
            );
        }
    }
    confirmed
}

/// Builds this job's project-wide LLM context document - see
/// `Job::llm_context`'s doc comment for what it's for and who reads it.
/// Called once, right after `canister_ids` is populated, entirely from real
/// values: the job's own business requirement, the canister ids
/// `verify_deployed_canister_ids` just independently confirmed, and - for
/// whichever canisters expose one - that canister's own live `llm_context()`
/// query (fetched fresh here, not templated, so a real deployment that
/// customized its own `llm_context.md` is reflected automatically). A
/// canister whose kind doesn't have that method (`Database`, `Static`,
/// `Other`) or whose call fails gets a short generic line instead - the
/// document always lists every canister, even ones it can't say much about.
///
/// Takes plain values rather than a `&JobContext` so it's callable from
/// anywhere a real project's directory and canister ids are known - not
/// just from inside this tool's own closure (see
/// `examples/dev_server_with_seed.rs`, which calls this same function for
/// the one manually-built job it seeds).
pub async fn generate_llm_context(
    project_name: &str,
    request: &str,
    network: &str,
    command_timeout_secs: u64,
    project_dir: &std::path::Path,
    canister_ids: &serde_json::Map<String, Value>,
) -> String {
    let is_mainnet = network == "ic";
    let timeout = Duration::from_secs(command_timeout_secs.min(20));

    let mut doc = format!("# {project_name}\n\nBusiness requirement this project was built for:\n\n> {request}\n\nNetwork: {network}\n\n## Canisters\n\n");

    for (name, id_value) in canister_ids {
        let Some(id) = id_value.as_str() else {
            continue;
        };
        let kind = crate::job::infer_canister_kind(name);
        doc.push_str(&format!("### `{name}` ({id})\n\n"));

        let exposes_llm_context =
            matches!(
                kind,
                crate::job::CanisterKind::Connector
                    | crate::job::CanisterKind::Agent
                    | crate::job::CanisterKind::AdminAgent
                    | crate::job::CanisterKind::Auth
                    | crate::job::CanisterKind::Database
            ) || matches!(name.as_str(), "order_inventory" | "order-inventory");
        let fetched = if exposes_llm_context {
            crate::canister_query::call_candid_text(
                project_dir,
                name,
                "llm_context",
                "()",
                true,
                is_mainnet,
                timeout,
            )
            .await
            .and_then(|candid_text| crate::candid_text::extract_text_reply(&candid_text))
        } else {
            None
        };

        match fetched {
            Some(text) => doc.push_str(&text),
            None => doc.push_str(match kind {
                crate::job::CanisterKind::Static => {
                    "Serves this project's public web UI over HTTP."
                }
                crate::job::CanisterKind::Analytics => {
                    "Records counters, gauges, logs, and histograms under arbitrary named keys \
                     (`ic-analytics`'s prebuilt release) - see its own candid interface for the \
                     exact query surface, since it exposes no `llm_context`."
                }
                _ => "No further self-description available for this canister.",
            }),
        }
        doc.push_str("\n\n");
    }

    doc
}

/// Reads the canister names under an icp.yaml's top-level `canisters:` key -
/// a minimal, deliberately non-general line scanner (this project has no
/// YAML dependency otherwise) rather than pulling in a full YAML parser for
/// one small list, but indentation-aware enough to handle both real shapes
/// icp-cli actually produces (verified directly against a real `icp
/// new`-scaffolded project's own icp.yaml, not assumed): most entries are a
/// bare path to a subfolder with its own canister.yaml (e.g. `- connector`,
/// name = the path's last segment), but a freshly scaffolded project's own
/// *default* canister is listed inline instead (`- name: backend` followed
/// by a nested, more-indented `recipe:` block right in icp.yaml, no separate
/// canister.yaml at all). An earlier version of this function treated every
/// list item as a bare string and stopped at the first non-`- `-prefixed
/// line - which silently misread that inline entry as a canister literally
/// named `"name: backend"` *and* stopped scanning at its nested `recipe:`
/// line, dropping every canister listed after it. Every canister a coding
/// subagent adds itself uses the bare-path shape (see
/// `coding_subagent_preamble`), so this matters most for the one canister
/// already there before it starts.
fn parse_icp_yaml_canister_names(path: &std::path::Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let mut names = Vec::new();
    let mut canisters_indent: Option<usize> = None;
    let mut list_item_indent: Option<usize> = None;

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim_start();

        let Some(canisters_indent) = canisters_indent else {
            if trimmed == "canisters:" {
                canisters_indent = Some(indent);
            }
            continue;
        };

        // A line more-indented than the current list item's own `- ` marker
        // is part of that item's nested body (e.g. an inline entry's
        // `recipe:`/`configuration:` block) - not a new item, and not the
        // end of the list either.
        if let Some(item_indent) = list_item_indent {
            if indent > item_indent {
                continue;
            }
        }

        if indent <= canisters_indent {
            break; // dedented back to a sibling top-level key - list is over
        }

        let Some(item) = trimmed.strip_prefix("- ") else {
            break; // same indentation as list items, but not one - malformed; stop rather than guess
        };
        list_item_indent = Some(indent);

        let name = match item.strip_prefix("name:") {
            // Inline `{name, recipe}` entry - only the name matters for
            // `icp canister id`/`icp build`; the recipe body that follows is
            // skipped above as nested content.
            Some(rest) => rest.trim().trim_matches('"').to_string(),
            // A bare path to a subfolder with its own canister.yaml (e.g.
            // `connector`, or `packages/connector` if ever nested) - that
            // subfolder's own canister.yaml names itself to match its
            // basename, the same convention every building block and every
            // hand-written static/assets canister.yaml already follows.
            None => item
                .trim()
                .trim_matches('"')
                .rsplit('/')
                .next()
                .unwrap_or(item.trim())
                .to_string(),
        };
        names.push(name);
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_icp_yaml_canister_names_reads_a_flat_list() {
        let dir = std::env::temp_dir().join(format!("icp-yaml-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("icp.yaml");
        std::fs::write(
            &path,
            "# a comment\ncanisters:\n  - connector\n  - agent\n  - \"quoted-name\"\n\n",
        )
        .unwrap();

        let names = parse_icp_yaml_canister_names(&path).unwrap();
        assert_eq!(
            names,
            vec![
                "connector".to_string(),
                "agent".to_string(),
                "quoted-name".to_string()
            ]
        );
    }

    #[test]
    fn parse_icp_yaml_canister_names_stops_at_the_next_top_level_key() {
        let dir = std::env::temp_dir().join(format!("icp-yaml-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("icp.yaml");
        std::fs::write(&path, "canisters:\n  - connector\nsome_other_key: value\n").unwrap();

        let names = parse_icp_yaml_canister_names(&path).unwrap();
        assert_eq!(names, vec!["connector".to_string()]);
    }

    #[test]
    fn parse_icp_yaml_canister_names_reads_an_inline_name_recipe_entry() {
        // The real shape a freshly `icp new`-scaffolded project's own
        // default canister uses - verified directly against a real
        // scaffold, not assumed. The old version of this function misread
        // this as a canister literally named `"name: backend"`.
        let dir = std::env::temp_dir().join(format!("icp-yaml-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("icp.yaml");
        std::fs::write(
            &path,
            "canisters:\n  - name: backend\n    recipe:\n      type: \"@dfinity/rust@v3.4.0\"\n      configuration:\n        shrink: true\n",
        )
        .unwrap();

        let names = parse_icp_yaml_canister_names(&path).unwrap();
        assert_eq!(names, vec!["backend".to_string()]);
    }

    #[test]
    fn parse_icp_yaml_canister_names_reads_bare_entries_after_an_inline_one() {
        // The real, common case this project actually produces: the
        // scaffolded default canister (inline) followed by building blocks
        // the coding subagent added afterward (bare paths). The old version
        // would `break` at the inline entry's nested `recipe:` line and
        // never see anything listed after it at all.
        let dir = std::env::temp_dir().join(format!("icp-yaml-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("icp.yaml");
        std::fs::write(
            &path,
            "canisters:\n  - name: backend\n    recipe:\n      type: \"@dfinity/rust@v3.4.0\"\n      configuration:\n        shrink: true\n        metadata:\n          - name: \"crate:version\"\n            value: 1.0.0\n  - connector\n  - agent\n",
        )
        .unwrap();

        let names = parse_icp_yaml_canister_names(&path).unwrap();
        assert_eq!(
            names,
            vec![
                "backend".to_string(),
                "connector".to_string(),
                "agent".to_string()
            ]
        );
    }

    #[test]
    fn parse_icp_yaml_canister_names_extracts_the_basename_of_a_nested_path() {
        let dir = std::env::temp_dir().join(format!("icp-yaml-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("icp.yaml");
        std::fs::write(&path, "canisters:\n  - packages/connector\n").unwrap();

        let names = parse_icp_yaml_canister_names(&path).unwrap();
        assert_eq!(names, vec!["connector".to_string()]);
    }

    #[test]
    fn parse_icp_yaml_canister_names_errors_on_a_missing_file() {
        let missing =
            std::env::temp_dir().join(format!("no-such-icp-yaml-{}.yaml", uuid::Uuid::new_v4()));
        assert!(parse_icp_yaml_canister_names(&missing).is_err());
    }

    fn config_with_no_identity() -> Config {
        Config {
            bind_addr: String::new(),
            workspace_root: PathBuf::new(),
            marketplace_canister_id: Principal::anonymous(),
            hnsw_canister_id: Principal::anonymous(),
            search_top_k: 1,
            search_relevance_threshold: 0.0,
            ic_url_local: String::new(),
            ic_url_mainnet: String::new(),
            identity_seed_phrase: None,
            deploy_identity_pem: None,
            cycles_wallet_canister_id: None,
            canister_creation_cycles: 0,
            command_timeout_secs: 1,
            shell_idle_timeout_secs: 1,
            building_blocks_dir: PathBuf::new(),
            llm_provider: "openai".to_string(),
            llm_model: None,
            llm_max_turns: 1,
            llm_subagent_max_turns: 1,
            ask_user_timeout_secs: 1,
            ollama_tool_result_shim: true,
            icp_template_git: String::new(),
            icp_template_subfolder: String::new(),
            require_auth: false,
            auth_network: "local".to_string(),
            github_oauth_client_id: None,
            github_oauth_client_secret: None,
            public_base_url: None,
            github_api_token: None,
        }
    }

    #[test]
    fn write_deploy_identity_file_errors_clearly_when_nothing_is_configured() {
        let dir = std::env::temp_dir().join(format!("identity-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = write_deploy_identity_file(&config_with_no_identity(), &dir).unwrap_err();
        assert!(
            err.contains("no identity configured"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn write_deploy_identity_file_writes_a_seed_file_when_a_seed_phrase_is_configured() {
        let dir = std::env::temp_dir().join(format!("identity-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = config_with_no_identity();
        config.identity_seed_phrase =
            Some(crate::config::Redacted::for_test("my seed phrase words"));

        let path = write_deploy_identity_file(&config, &dir).unwrap();
        assert_eq!(path, dir.join(".orchestrator-identity.seed"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "my seed phrase words"
        );
    }

    #[test]
    fn write_deploy_identity_file_copies_the_pem_file_when_one_is_configured() {
        let dir = std::env::temp_dir().join(format!("identity-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pem_path = dir.join("source-identity.pem");
        std::fs::write(
            &pem_path,
            "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
        )
        .unwrap();
        let mut config = config_with_no_identity();
        config.deploy_identity_pem = Some(pem_path.clone());

        let dest_dir = dir.join("project");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let path = write_deploy_identity_file(&config, &dest_dir).unwrap();
        assert_eq!(path, dest_dir.join(".orchestrator-identity.pem"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            std::fs::read_to_string(&pem_path).unwrap()
        );
    }

    #[test]
    fn write_deploy_identity_file_prefers_pem_over_seed_phrase_when_both_are_set() {
        let dir = std::env::temp_dir().join(format!("identity-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pem_path = dir.join("source-identity.pem");
        std::fs::write(&pem_path, "pem-content").unwrap();
        let mut config = config_with_no_identity();
        config.deploy_identity_pem = Some(pem_path);
        config.identity_seed_phrase = Some(crate::config::Redacted::for_test("should not be used"));

        let path = write_deploy_identity_file(&config, &dir).unwrap();
        assert_eq!(path, dir.join(".orchestrator-identity.pem"));
    }
}
