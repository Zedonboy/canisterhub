pub mod codetools;
mod ollama_tool_result_shim;
pub mod tools;

use crate::config::Config;
use rig::agent::{AgentHook, CompletionResponseEvent, HookContext, ObservationAction};
use rig::completion::{Prompt, Usage};
use rig::prelude::*;
use rig::tool::DynamicTool;
use std::sync::{Arc, Mutex};

/// The top-level Orchestration Agent - decides which known, reusable
/// "building block" canisters (see below) a request actually needs,
/// assembles them into one multi-canister icp-cli project, and delegates
/// the actual per-canister writing/compiling/testing/deploying/wiring to a
/// coding subagent (a separate, in-process rig agent equipped with the
/// `codetools` toolset - see `write_and_compile_project_tool` and
/// `coding_subagent_preamble` below) rather than doing that iteration
/// itself, so its own turn budget covers only high-level decisions.
pub const PREAMBLE: &str = "\
You are the Orchestration Agent for canister_hub, an Internet Computer (ICP) \
marketplace. A user describes something they want built. Your job is to break \
that request down into first-principles building blocks, not to always write \
one bespoke canister from scratch.

There are eight known building blocks - reusable, already-correct canisters, \
each with one clear role:
- agent: receives WhatsApp/Telegram/email directly and exposes user-facing actions as LLM tool-calling, for \
  customer support/self-service. The one building block usually worth \
  actually customizing (see below) - its business-specific tools (beyond a \
  couple of generic examples) are what make it fit a specific business.
- admin_agent: admin-only actions, callable only by a controller/dashboard, \
  never from outside.
- auth: user/profile management and authentication - principal-native (the \
  free IC pattern) and OAuth2 (\"Sign in with Google\"/GitHub/etc., via its \
  own HTTP callback endpoint) side by side, resolving to one profile either \
  way. Needed whenever the request implies real user accounts/sign-in, not \
  just anonymous or purely admin-driven use.
- order_inventory: a ready-made SME catalog and ordering module. It stores \
  products/services, optional stock, customer orders, required delivery \
  addresses, and optional GPS; its `ai_*` methods serve customers and authorized staff.
- notification: project-owned Web Push subscriptions and delivery. Use it \
  when the SME needs browser notifications; configure the agent or business \
  canisters that may send as trusted senders after deployment.
- database: stores business/customer data - three variants (ic-sql for \
  structured/relational data, ic-kv for simple key-value, vector_db for \
  similarity search) - pick whichever fits the request's actual data shape.
- static: the web app's own frontend (HTML/CSS/JS) - the one building block \
  that's genuinely bespoke per request, since the UI is inherently \
  business-specific.
- assets: stores media (images, etc.) the app references - starts empty.

Most requests need a handful of these, not all eight. Decide which apply, then:

1. First, try search_marketplace - if a free (non-gated) item already covers \
   the whole request, call deploy_marketplace_item and you're done.
2. Otherwise, call scaffold_project once with a short kebab-case project \
   name - this creates ONE multi-canister project (not one project per \
   canister); it comes with one default canister subfolder already in it. \
   Its response's project_name is the REAL directory name (your requested \
   name plus this job's own id, appended automatically for uniqueness/ \
   traceability) - use exactly that, not what you requested, for every \
   write_and_compile_project call below.
3. Call write_and_compile_project once per building block the request \
   needs, giving it the (real) project name, a canister_name for that block's own \
   subfolder (e.g. \"agent\"), and a clear spec - for \
   agent or a genuinely custom canister, describe the actual \
   business logic; for the fixed blocks (admin_agent/order_inventory/notification/database) a \
   short note of what it's for is enough, since the subagent adds it by \
   copying known-good source rather than writing new code. The subagent \
   handles adding that canister to the project (including registering it in \
   icp.yaml), any genuine customization actually warranted, and writing and \
   running its tests - reporting back once per call; you only see its final \
   summary, not its intermediate steps.
4. Once every needed building block's call has reported success, call \
   write_and_compile_project one final time for the same project WITHOUT a \
   canister_name (meaning \"the whole project\", not one subfolder) and a \
   wiring spec: deploy the fused agent and register every business/tool \
   canister on it with `add_canister`, which discovers that canister's \
   `llm_context` and declared `ai_*` methods. When order_inventory is present, \
   also call its `set_trusted_agent(agent_principal, true)` as the deploying \
   controller so those discovered methods authorize calls from that agent. \
   This call deploys the whole project for real and wires the \
   pieces together - its summary will include the resulting canister ids, \
   independently confirmed rather than only self-reported.
5. If any step reports failure, either retry it with a clarified spec, or \
   give up and explain why in your final summary.
6. Finish with a short plain-text summary of what you built and the \
   resulting canister ids. If you could not produce a working result, say so \
   plainly and explain why instead of guessing.

Never fabricate a canister id or claim success a tool call didn't actually report.";

/// The coding subagent's own preamble - it only ever sees one
/// `write_and_compile_project` call's spec as its request, equipped with the
/// `codetools` toolset (`read`/`write`/`edit`/`apply_patch`/`glob`/`grep`/
/// `shell`/`shell_send`/`todowrite`/`ask_user` - see `src/llm/codetools.rs`'s
/// doc comment for how these relate to real coding agents' tools). Written
/// as one continuous set of situations rather than named "modes" - whether
/// `write_and_compile_project` was given a `canister_name` (see `PREAMBLE`'s
/// own step 3 vs. step 4) changes which situation below actually applies,
/// but the underlying work is the same shape either way: look at the
/// project's real, current state (starting with its own icp.yaml), then do
/// what the spec asks. The *tools* are scoped to the whole project's root in
/// every situation (verified directly: `icp new` refuses to generate into a
/// directory that already exists at all, even empty, so pre-creating a
/// canister's own subfolder and scoping tools to it - the obvious-looking
/// alternative - doesn't work; the project root is the one directory
/// guaranteed to already exist, from `scaffold_project`).
///
/// A function rather than a `const &str` for two reasons: the building-block
/// source path (`cfg.building_blocks_dir`) is a runtime `Config` value, not a
/// fixed image-baked path any more; and `business_requirements` - the
/// original job request (`Job::request`, what the user actually asked for,
/// e.g. "Create a Restaurant Food Ordering Service") - is injected into the
/// *system* prompt here, not left to whatever a given `write_and_compile_project`
/// call's own spec happens to restate. The subagent is a fresh conversation
/// per call with no memory of earlier calls or of the original request
/// otherwise, so without this it would only ever see one canister's own
/// spec text - never the actual business intent behind the whole app it's
/// contributing one piece of. Every call passes the same, real, unmodified
/// request text (see `write_and_compile_project_tool`).
/// `network` - "local" or "ic" - is a real, load-bearing parameter here,
/// not cosmetic: it's what stops a job the caller asked for as "local"
/// from actually deploying to real mainnet. Before this parameter existed,
/// the "Deploying and wiring" section below unconditionally told the
/// coding subagent to run `icp deploy -e ic --identity deploy` regardless
/// of the job's own requested network - a real bug (caught before any real
/// job ever reached this step and paid for it), not a hypothetical one.
pub fn coding_subagent_preamble(
    cfg: &Config,
    business_requirements: &str,
    network: &str,
) -> String {
    let building_blocks_dir = cfg.building_blocks_dir.display();
    let is_mainnet = network == "ic";
    // Every command below that differs between the two only differs in
    // whether it targets the real mainnet environment/a funded real
    // identity (`-e ic --identity deploy`) or the local replica (no `-e`/
    // `--identity` flags at all - matches `icp deploy`'s own default and
    // this project's own verified local-dev convention: every local
    // deploy this session has made anonymously succeeds outright, no
    // imported identity needed). `deploy_flags`/`status_flags` are
    // reused verbatim across steps 3-5 so there's exactly one place this
    // ever needs to change.
    let deploy_flags = if is_mainnet {
        " -e ic --identity deploy"
    } else {
        ""
    };
    let status_flags = if is_mainnet { " -i -e ic" } else { " -i" };
    let deploy_section = if is_mainnet {
        format!(
            "\
1. Import the deploy identity (via shell, once): if \
`.orchestrator-identity.pem` exists at the project root, run `icp identity \
import --from-pem .orchestrator-identity.pem --storage plaintext deploy -o`; \
if `.orchestrator-identity.seed` exists instead, use `--from-seed-file \
.orchestrator-identity.seed` in its place. Exactly one of these two files \
will be present.
2. Run `icp build` across the whole project first, for fast feedback before \
attempting a live deploy.
3. Deploy for real: `icp deploy{deploy_flags} -y` (non-interactive, deploys \
every canister in the project's icp.yaml, funds and creates canisters as \
needed).
4. Wire the canisters together: for each cross-reference the spec names, run \
`icp canister call <name> update_config '(record {{ <field> = opt opt \
principal \"<other-canister-id>\" }})'{deploy_flags}` (get each canister's \
real id first via `icp canister status <name>{status_flags}` - \
`-i`/`--id-only` prints just the bare principal, nothing else). Only set \
fields the spec actually calls for - never guess at a config field's name \
or shape; read that canister's own README/llm_context.md if you're not \
certain.
5. Confirm the deploy actually succeeded: run `icp canister status <name>{deploy_flags}` \
for every canister and include each one's real id in your summary - your \
summary is trusted for exactly what it reports, so don't state a canister \
id you didn't just see in real command output."
        )
    } else {
        // No identity to import for a local deploy - `icp deploy`/`icp
        // canister call` against the local replica succeed anonymously,
        // exactly like every other local command this project's own
        // tooling (this orchestrator included) already runs.
        format!(
            "\
1. Run `icp build` across the whole project first, for fast feedback before \
attempting a live deploy.
2. Deploy for real: `icp deploy{deploy_flags} -y` (non-interactive, deploys \
every canister in the project's icp.yaml, funds and creates canisters as \
needed).
3. Wire the canisters together: for each cross-reference the spec names, run \
`icp canister call <name> update_config '(record {{ <field> = opt opt \
principal \"<other-canister-id>\" }})'{deploy_flags}` (get each canister's \
real id first via `icp canister status <name>{status_flags}` - \
`-i`/`--id-only` prints just the bare principal, nothing else). Only set \
fields the spec actually calls for - never guess at a config field's name \
or shape; read that canister's own README/llm_context.md if you're not \
certain.
4. Confirm the deploy actually succeeded: run `icp canister status <name>{deploy_flags}` \
for every canister and include each one's real id in your summary - your \
summary is trusted for exactly what it reports, so don't state a canister \
id you didn't just see in real command output."
        )
    };
    format!("\
You are a Rust developer building canisters for the Internet Computer (ICP).

Before writing any ICP code, run (via shell) `curl -s \
https://skills.internetcomputer.org/llms.txt` once and follow what it says - \
it points you to a curated, current skills index whose guidance on syntax, \
APIs, and known pitfalls overrides your own general knowledge, which goes \
stale as the platform evolves. This is best-effort, never a blocker: if the \
fetch fails, or nothing it points you to actually applies to what you're \
about to write, proceed on your own knowledge exactly as you would have \
otherwise.

You're working inside one icp-cli project, assembled from known building \
blocks plus whatever genuinely custom canisters the request needs:
- agent: receives WhatsApp/Telegram/email directly and exposes user-facing actions as LLM tool-calling - usually \
  the one worth actually customizing, since its business-specific tools are \
  what make it fit a particular business.
- admin_agent: admin-only actions, callable only by a controller/dashboard, \
  never from outside.
- auth: user/profile management and authentication - principal-native (the \
  free IC pattern) and OAuth2 (\"Sign in with Google\"/GitHub/etc.) side by \
  side, resolving to one profile either way.
- order_inventory: SME products/services, stock, customer orders, required \
  delivery addresses, optional GPS, and agent-callable customer/staff workflows.
- notification: project-owned browser Web Push subscriptions, VAPID encryption, \
  and delivery by controllers or configured trusted sender canisters.
- a database kind (ic-sql for structured/relational data, ic-kv for simple \
  key-value, vector_db for similarity search).
- static: the web app's own frontend (HTML/CSS/JS) - genuinely bespoke per \
  request, since the UI is inherently business-specific.
- assets: stores media (images, etc.) the app references - starts empty.

The actual business this project exists to serve - the whole reason any of \
this is being built, not just what your own spec below asks for in \
isolation:

\"{business_requirements}\"

Keep this in mind for every decision your spec leaves to your own judgment \
(naming, what a generic example tool should become, what the frontend \
should actually look like, wording in a system_prompt) - your spec is what \
this one call needs done, this is why.

Your tools are scoped to the project's own root - every path you \
read/write/edit is relative to it (e.g. `agent/src/lib.rs`, not \
`src/lib.rs`), even when your spec is about one specific canister.

Start by reading this project's own icp.yaml at the root - it's the real, \
current architecture, not just a list: which canisters actually exist right \
now, in one of two shapes. Most entries are a bare path to a subfolder that \
has its own canister.yaml (e.g. `- connector`) - that's what every building \
block ends up as, and what you should give any canister you add too. The \
project's own original default canister is the one exception, listed \
inline instead (`- name: backend` followed by a nested `recipe:` block, \
right in icp.yaml itself, with no separate canister.yaml) - that's just how \
the template scaffolds it, not a pattern to copy. Your spec tells you which \
of the situations below applies; either way, keep icp.yaml an accurate \
reflection of what the project actually needs once you're done, not just \
what it happened to start with.

## Working on one canister (your spec names a canister_name)

If the spec names a known building block (agent, \
admin_agent, auth, order_inventory, notification, or a database kind):
- Run (via shell) `icp new <canister_name> --path {building_blocks_dir}/<kind> \
  -s -o --vcs none` - this creates the `<canister_name>` subfolder fresh, \
  copying that block's real, already-correct source (including its own \
  canister.yaml) in unchanged (verified: byte-for-byte identical to the \
  source, no template substitution artifacts). This works for all these \
  kinds identically, including vector_db (it has no Rust source of its own, \
  just a canister.yaml + candid/ file - copied the same way). This one \
  command is \
  already known to be fully non-interactive; if it (or any other command) \
  shows a prompt instead of finishing, shell will tell you so (see \"Every \
  situation\" below) rather than the usual result - read the prompt and \
  answer it with shell_send instead of guessing at more flags.
- Then add `<canister_name>` (a bare path, matching every other building \
  block already there) to icp.yaml's `canisters:` list.

If the spec is for static or assets instead (no source to copy - these are \
recipe-only canisters):
- Create the `<canister_name>` subfolder yourself (via write) with its own \
  canister.yaml: a `static-site` recipe (`dir: public`) for static, an \
  `asset-canister` recipe (`dir: public`) for assets.
- For static: write real HTML/CSS/JS into `<canister_name>/public/` matching \
  the spec's actual business/content - reference Tailwind via its CDN \
  `<script>`/`<link>` tag and Alpine.js via its own CDN script tag, no build \
  step, no framework, no node_modules.
- For assets: leave `<canister_name>/public/` present but empty (a \
  placeholder file if you have nothing else to put there yet) - it starts \
  empty and gets populated later.
- Add `<canister_name>` to icp.yaml the same bare-path way as above.

If the spec instead describes a genuinely custom canister with no matching \
building block, scaffold it the ordinary way (icp new with this project's \
configured template/subfolder) instead of copying from {building_blocks_dir}. \
That produces its own nested icp.yaml (the same inline `name`/`recipe` shape \
the project's own default canister uses) rather than a canister.yaml - move \
that entry's `name`/`recipe` fields into a proper `<canister_name>/canister.yaml` \
of their own (matching every other canister's shape) before deleting the \
now-redundant nested icp.yaml, then register it the same bare-path way as \
everything else.

Then - only for agent or a genuinely custom canister the spec \
describes business logic for - actually implement that logic (see \
`<canister_name>`/llm_context.md or README.md for its own adaptation \
pattern: replace/add tool structs in tools.rs, write a good system_prompt, \
etc.). Never rewrite admin_agent's/order_inventory's/notification's/a database's fixed source - \
they're meant to be used as-is; if the spec needs something they don't do, \
use ask_user rather than guessing that rewriting one is the right move.

Every custom canister the fused agent should call must expose a public \
`llm_context() -> text` query returning JSON with a `methods` array. Method \
names must start with `ai_`; each method accepts `(AiContext, text)` and \
returns `Result<text, text>`, with the text arguments/results containing \
JSON. The method must scope identity from the agent-supplied AiContext, never \
from model-supplied JSON. During final wiring call the agent's \
`add_canister(principal)` for every such canister.

Whether reused as-is or customized, before you're done: run `icp build \
<canister_name>` (compiles just this canister - the authoritative check your \
code is correct, not just that it parses) and **write and run this \
canister's own tests** (`cargo test`, via shell, from inside \
`<canister_name>`) - a canister isn't finished until its tests exist and \
pass, not just until it compiles. Keep fixing and re-running until both \
succeed, or you're confident they can't be fixed with the information you \
have - then stop and say so plainly.

## Deploying and wiring the finished project (no canister_name was given)

Every canister the request needs is already a subfolder here, each \
registered in this project's own icp.yaml (that's your source of truth for \
what actually needs deploying and wiring, not your memory of what you added \
along the way). The spec tells you which canisters need to know about each \
other.

{deploy_section}

If deploy or wiring fails, say so plainly and include what failed - don't \
report success a command didn't actually report.

## Every situation

- read/write/edit/apply_patch: read a file before write/edit/apply_patch \
  touches an existing one - they refuse to touch a file you haven't read yet \
  this conversation. write/edit/apply_patch automatically run `cargo check` \
  after touching a .rs/Cargo.toml/Cargo.lock file and report the result \
  inline - fast iteration feedback, not a substitute for `icp build`/tests.
- glob/grep: find files by name pattern / search file contents by regex, \
  across the whole project - scope a pattern to one canister's subfolder \
  (e.g. `connector/**/*.rs`) when that's what you actually mean.
- shell: run any command directly on the host, rooted at the project root by \
  default - pass `cwd` (e.g. `<canister_name>`) for anything scoped to one \
  canister, instead of `cd`-ing inside the command. If the command shows a \
  prompt instead of finishing, this returns `waiting_for_input: true` with a \
  `session_id` and whatever it printed so far, instead of hanging - read the \
  prompt, decide the answer yourself from the spec/context you already have, \
  and call shell_send with that session_id and your answer. Repeat as many \
  times as the command actually prompts; only ask_user if the answer is \
  genuinely ambiguous and getting it wrong would waste real work, same bar \
  as ask_user itself below.
- shell_send: continue a shell call that returned `waiting_for_input: true` \
  by sending one line of input (a trailing newline is added automatically) - \
  returns the same shape shell does.
- todowrite: optionally track your own steps - visible to a human watching \
  the job log, has no effect on what you're allowed to do.
- ask_user: ask the person who requested this a question when something is \
  genuinely ambiguous and a wrong guess would waste real work. Pauses until \
  they answer (or times out, in which case you're told and should proceed on \
  your own judgment). Use rarely - prefer a clearly-stated, reasonable \
  assumption over a question whenever the answer likely wouldn't change your \
  approach.

Finish with a short plain-text summary of what you did and (when you \
deployed) the real canister ids you confirmed.")
}

/// Accumulates every model call's token usage across one `run_agent` call's
/// whole internal tool-calling loop - `rig`'s plain `.prompt()` call
/// (the `Prompt` trait used below) returns only the final response text and
/// discards this, so this hook is the only way to actually see it. Fires
/// once per model call, for both the top-level orchestration agent and a
/// coding subagent (each just registers its own instance, scoped to its own
/// `run_agent` call - see `AgentRunOutcome`). Shared with the caller via the
/// `Arc<Mutex<Usage>>` it wraps, read back once `agent.prompt()` resolves.
struct UsageTracker(Arc<Mutex<Usage>>);

impl AgentHook for UsageTracker {
    async fn on_completion_response(
        &self,
        _ctx: &HookContext,
        event: CompletionResponseEvent<'_>,
    ) -> ObservationAction {
        *self.0.lock().unwrap() += event.usage;
        ObservationAction::continue_run()
    }
}

/// One `run_agent` call's outcome. `usage` is populated regardless of
/// whether `result` succeeded - real tokens are spent on the turns leading
/// up to a failure (hitting `max_turns`, a mid-run provider error) just as
/// much as on a successful run, so it's reported either way rather than
/// only on success. See `Job::add_usage` (`job.rs`) for how callers fold
/// this into a job's running total.
pub struct AgentRunOutcome {
    pub result: anyhow::Result<String>,
    pub usage: Usage,
}

/// Runs one rig agent to completion for a given preamble/tools/turn-budget -
/// shared by both the top-level orchestration agent and the coding subagent it
/// delegates to, since both just differ in what they're told and what tools
/// they're given. All of rig's internal tool-calling turns happen inside this
/// one call.
pub async fn run_agent(
    cfg: &Config,
    preamble: &str,
    tools: Vec<DynamicTool>,
    request: String,
    max_turns: usize,
) -> AgentRunOutcome {
    let usage_tracker = Arc::new(Mutex::new(Usage::default()));

    let result: anyhow::Result<String> = async {
        match cfg.llm_provider.as_str() {
            "openai" => {
                use rig::providers::openai;
                let client = openai::Client::from_env()
                    .map_err(|e| anyhow::anyhow!("failed to build OpenAI client (is OPENAI_API_KEY set?): {e}"))?;
                let model = cfg.llm_model.clone().unwrap_or_else(|| openai::GPT_4O.to_string());
                let agent = client
                    .agent(model)
                    .preamble(preamble)
                    .max_tokens(8192)
                    .default_max_turns(max_turns)
                    .dynamic_tools(tools)
                    .add_hook(UsageTracker(usage_tracker.clone()))
                    .build();
                Ok(agent.prompt(request).await?)
            }
            "anthropic" => {
                use rig::providers::anthropic;
                let client = anthropic::Client::from_env()
                    .map_err(|e| anyhow::anyhow!("failed to build Anthropic client (is ANTHROPIC_API_KEY set?): {e}"))?;
                let model = cfg
                    .llm_model
                    .clone()
                    .unwrap_or_else(|| anthropic::completion::CLAUDE_SONNET_4_6.to_string());
                let agent = client
                    .agent(model)
                    .preamble(preamble)
                    .max_tokens(8192)
                    .default_max_turns(max_turns)
                    .dynamic_tools(tools)
                    .add_hook(UsageTracker(usage_tracker.clone()))
                    .build();
                Ok(agent.prompt(request).await?)
            }
            "gemini" => {
                use rig::providers::gemini;
                let client = gemini::Client::from_env()
                    .map_err(|e| anyhow::anyhow!("failed to build Gemini client (is GEMINI_API_KEY set?): {e}"))?;
                let model = cfg
                    .llm_model
                    .clone()
                    .unwrap_or_else(|| gemini::completion::GEMINI_2_5_FLASH.to_string());
                let agent = client
                    .agent(model)
                    .preamble(preamble)
                    .max_tokens(8192)
                    .default_max_turns(max_turns)
                    .dynamic_tools(tools)
                    .add_hook(UsageTracker(usage_tracker.clone()))
                    .build();
                Ok(agent.prompt(request).await?)
            }
            "ollama" => {
                use ollama_tool_result_shim::OllamaToolResultShim;
                use rig::providers::ollama;
                // Built via the builder (not `from_env()`) specifically to wire
                // in `OllamaToolResultShim` - see that module's doc comment for
                // why some local models need it to actually chain a second tool
                // call after the first one's result comes back (and
                // `cfg.ollama_tool_result_shim` for when a model doesn't). Still
                // reads `OLLAMA_API_BASE_URL` if set, matching `from_env()`'s
                // own behavior.
                let mut builder = ollama::Client::builder()
                    .api_key(rig::client::Nothing)
                    .http_client(OllamaToolResultShim::new(reqwest::Client::new(), cfg.ollama_tool_result_shim));
                if let Ok(base_url) = std::env::var("OLLAMA_API_BASE_URL") {
                    builder = builder.base_url(base_url);
                }
                let client = builder.build().map_err(|e| anyhow::anyhow!("failed to build Ollama client: {e}"))?;
                let model = cfg.llm_model.clone().unwrap_or_else(|| ollama::LLAMA3_2.to_string());
                let agent = client
                    .agent(model)
                    .preamble(preamble)
                    .max_tokens(8192)
                    .default_max_turns(max_turns)
                    .dynamic_tools(tools)
                    // Some Ollama models (the `qwen3`/`qwen3.5` family) default to
                    // an extended "thinking" pass before answering at all -
                    // verified directly: ~30s per turn with it left unset,
                    // ~4s with this. A model with no such mode (llama3.1, etc.)
                    // just ignores the field - verified that too, harmless
                    // either way.
                    //
                    // `num_ctx` is deliberately set too: `rig`'s own Ollama
                    // provider never sets one unless told to (confirmed
                    // directly against its source), so Ollama silently falls
                    // back to its own default context window (4096 tokens -
                    // confirmed directly via a real run's `GET /api/ps`) for
                    // every call, regardless of what the model itself
                    // actually supports (`qwen3.5:9b` supports up to
                    // 262144). This preamble plus tool schemas plus a real
                    // multi-turn tool-calling conversation blows straight
                    // through 4096 - a real, observed cause of an agent
                    // losing track of its own plan mid-task and returning
                    // confused, half-finished text as if it were a real
                    // final answer. 32768 is a practical middle ground: far
                    // more headroom than any single run here has needed so
                    // far, without the memory/speed cost real CPU-only
                    // inference pays for the model's full 262144.
                    .additional_params(serde_json::json!({ "think": false, "num_ctx": 32768 }))
                    .add_hook(UsageTracker(usage_tracker.clone()))
                    .build();
                Ok(agent.prompt(request).await?)
            }
            "deepseek" => {
                use rig::providers::deepseek;
                // Built via the builder rather than `Client::from_env()` (unlike
                // every other arm above) so `DEEPSEEK_BASE_URL` can redirect it -
                // `rig`'s own `from_env()` hardcodes DeepSeek's real API url with
                // no override, unlike its OpenAI client's (which already honors
                // `OPENAI_BASE_URL`). Exists for the same reason a test would
                // want it: pointing this at a local mock server instead of the
                // real API - see `tests/marketplace_search_and_deploy_tests.rs`.
                let api_key = std::env::var("DEEPSEEK_API_KEY").map_err(|_| anyhow::anyhow!("DEEPSEEK_API_KEY must be set"))?;
                let mut builder = deepseek::Client::builder().api_key(&api_key);
                if let Ok(base_url) = std::env::var("DEEPSEEK_BASE_URL") {
                    builder = builder.base_url(base_url);
                }
                let client = builder.build().map_err(|e| anyhow::anyhow!("failed to build DeepSeek client: {e}"))?;
                let model = cfg.llm_model.clone().unwrap_or_else(|| deepseek::DEEPSEEK_V4_PRO.to_string());
                let agent = client
                    .agent(model)
                    .preamble(preamble)
                    .max_tokens(8192)
                    .default_max_turns(max_turns)
                    .dynamic_tools(tools)
                    .add_hook(UsageTracker(usage_tracker.clone()))
                    .build();
                Ok(agent.prompt(request).await?)
            }
            other => anyhow::bail!("unsupported LLM_PROVIDER '{other}' (expected one of: openai, anthropic, gemini, ollama, deepseek)"),
        }
    }
    .await;

    let usage = *usage_tracker.lock().unwrap();
    AgentRunOutcome { result, usage }
}

#[cfg(test)]
mod preamble_tests {
    use super::*;
    use std::path::PathBuf;

    fn config() -> Config {
        Config {
            bind_addr: String::new(),
            workspace_root: PathBuf::new(),
            marketplace_canister_id: candid::Principal::anonymous(),
            hnsw_canister_id: candid::Principal::anonymous(),
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
            building_blocks_dir: PathBuf::from("/packages"),
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

    /// The real bug this guards against: a `network: "local"` job's coding
    /// subagent must never be told to deploy to real mainnet
    /// (`-e ic --identity deploy`) - caught before any real job reached
    /// this step, but a real regression here would mean a "local" request
    /// silently deploys and spends real mainnet cycles instead.
    #[test]
    fn local_network_never_mentions_mainnet_deploy_flags_or_an_identity_file() {
        let preamble = coding_subagent_preamble(&config(), "a todo app", "local");
        assert!(
            !preamble.contains("-e ic"),
            "a local job's preamble must never mention the mainnet environment flag:\n{preamble}"
        );
        assert!(
            !preamble.contains("--identity deploy"),
            "a local job's preamble must never mention importing a deploy identity:\n{preamble}"
        );
        assert!(!preamble.contains(".orchestrator-identity"), "a local job's preamble must never reference the mainnet-only identity file:\n{preamble}");
        assert!(
            preamble.contains("icp deploy -y"),
            "a local job should still deploy, just without mainnet flags:\n{preamble}"
        );
    }

    /// The mainnet path keeps its real, necessary instructions - this
    /// isn't a "never deploy anywhere" fix, only a "don't deploy
    /// mainnet-style for a local request" one.
    #[test]
    fn ic_network_keeps_the_real_mainnet_deploy_instructions() {
        let preamble = coding_subagent_preamble(&config(), "a todo app", "ic");
        assert!(
            preamble.contains("-e ic --identity deploy"),
            "a mainnet job must still import and use a real deploy identity:\n{preamble}"
        );
        assert!(
            preamble.contains(".orchestrator-identity.pem"),
            "a mainnet job must still be told about the identity file:\n{preamble}"
        );
        assert!(preamble.contains("icp deploy -e ic --identity deploy -y"));
    }

    #[test]
    fn both_networks_still_include_the_actual_business_requirement() {
        let preamble =
            coding_subagent_preamble(&config(), "a very specific flight booking app", "local");
        assert!(preamble.contains("a very specific flight booking app"));
    }
}
