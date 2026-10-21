use crate::config::Config;
use crate::ic;
use crate::job::{JobHandle, JobStore};
use crate::llm::{self, tools::JobContext};
use std::sync::Arc;

/// Spawns the whole /orchestrate flow as a background task and returns
/// immediately; the job's state is updated in place as the agent works.
/// This is purely in-memory (`JobStore`) - the orchestrator never reads or
/// writes `backend`'s `Project` record at all (see the
/// `decouple-orchestrator-api` project notes); the frontend is the only
/// party that ever does that, directly, as the real signed-in user.
pub fn spawn(config: Arc<Config>, jobs: JobStore, job: JobHandle) {
    tokio::spawn(async move {
        if let Err(e) = run(config.clone(), jobs, job.clone()).await {
            job.lock().unwrap().fail(e.to_string());
        }
    });
}

async fn run(config: Arc<Config>, jobs: JobStore, job: JobHandle) -> anyhow::Result<()> {
    let (request, network) = {
        let job = job.lock().unwrap();
        (job.request.clone(), job.network.clone())
    };

    // A real identity is required even just to search: `hnsw_index`'s
    // `marketplace_items` collection is owned by whichever identity created
    // it (see `ic::hnsw::ensure_marketplace_items_collection`, run at
    // startup) and grants no Reader/Writer access to anyone else, so an
    // anonymous caller can't even query it.
    let (agent, caller_principal) = ic::agent::build_agent_for_network(&config, &network, true).await?;
    let ctx = Arc::new(JobContext::new(job.clone(), jobs, config.clone(), Arc::new(agent), caller_principal, network));
    let tools = crate::llm::tools::build_tools(ctx);

    let max_turns = config.llm_max_turns as usize;
    let outcome = llm::run_agent(&config, llm::PREAMBLE, tools, request, max_turns).await;

    {
        let mut job = job.lock().unwrap();
        job.add_usage(outcome.usage);

        // Normalize the raw outcome first: a non-error message from the
        // top-level agent isn't genuinely a success unless something along
        // the way actually confirmed at least one deployed canister (or
        // already changed the job's state itself, e.g. the legacy
        // single-canister `deploy_marketplace_item` path, which doesn't
        // populate `canisters` but does its own `job.succeed()` before this
        // point ever runs). A context-starved local model can return
        // confused, half-finished text as its "final answer" without ever
        // completing the job - a real, observed failure mode (see
        // `llm::run_agent`'s own `num_ctx` doc comment) that a bare
        // Rust-level `Ok(_)` doesn't rule out on its own.
        let outcome_result = match outcome.result {
            Ok(message) if job.state == crate::job::JobState::Running && job.canisters.is_empty() => Err(format!(
                "the orchestration agent finished without deploying any canister - its own closing message: {message}"
            )),
            other => other.map_err(|e| e.to_string()),
        };

        match outcome_result {
            Ok(message) => {
                // A tool along the way may already have marked the job succeeded (with
                // a canister id); don't clobber that with just the closing message.
                if job.state == crate::job::JobState::Running {
                    job.succeed(None, message);
                } else if job.final_message.is_none() {
                    job.final_message = Some(message);
                }
            }
            Err(message) => job.fail(message),
        }
    }
    Ok(())
}
