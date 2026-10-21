use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    /// The coding subagent called `ask_user` and is paused, awaiting a
    /// human's answer via `POST /jobs/:id/answer` - see
    /// `llm/codetools.rs::ask_user_tool` and `JobStore::register_pending_answer`/
    /// `submit_answer`. `pending_question` names what's being asked.
    AwaitingAnswer,
    Succeeded,
    Failed,
}

/// Which building block a deployed canister actually is, inferred from its
/// name - the same convention `coding_subagent_preamble` instructs the
/// subagent to follow (name each canister after the building block it came
/// from: `connector`, `agent`, `admin_agent`, `auth`,
/// `ic-sql`/`ic-kv`/`vector_db`, `static`/`assets`), so a canister's own
/// name is a reliable signal of its kind without needing to track that
/// separately anywhere. Drives which canisters `routes::jobs::get_canister_stats`
/// asks for business stats (only `Connector`/`Agent` currently
/// expose a `get_stats` method) and how `tools::generate_llm_context`
/// describes each one. `Other` covers anything else, including this
/// project's own default `backend` canister - not a building block itself,
/// so nothing here assumes a shape for it.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CanisterKind {
    Connector,
    Agent,
    AdminAgent,
    /// User/profile management and authentication (see `packages/auth`) -
    /// principal-native and OAuth2 side by side.
    Auth,
    /// `ic-sql`, `ic-kv`, or `vector_db` - different storage engines, but
    /// nothing here currently distinguishes them (only `ic-sql` has a real
    /// query surface wired up so far - see `routes::database`).
    Database,
    /// `packages/analytics` (`ic-analytics`'s prebuilt "user canister"
    /// release) - counters/gauges/logs/histograms. A pinned third-party
    /// wasm, not our own crate, so unlike `Database` it exposes no
    /// `llm_context` query (see `generate_llm_context`'s own
    /// `exposes_llm_context` match).
    Analytics,
    Static,
    Other,
}

pub fn infer_canister_kind(name: &str) -> CanisterKind {
    match name {
        "connector" => CanisterKind::Connector,
        "agent" => CanisterKind::Agent,
        "admin_agent" => CanisterKind::AdminAgent,
        "auth" => CanisterKind::Auth,
        // Keep the former PostgreSQL-branded spelling as a compatibility
        // alias for already-published marketplace items.
        "ic-sql" | "ic_sql" | "ic-pgsql" | "ic_pgsql" | "ic-kv" | "ic_kv" | "vector_db" | "vector-db" => CanisterKind::Database,
        "analytics" => CanisterKind::Analytics,
        "static" | "assets" => CanisterKind::Static,
        _ => CanisterKind::Other,
    }
}

/// One deployed canister's identity, as tracked on `Job::canisters`: its
/// real principal and which building block it is - a first-class, stored
/// field rather than re-inferred from the name every time it's needed (the
/// dashboard's "only a `Static` canister gets an Open-link button" rule and
/// the admin database viewer's "which canister is the database" lookup
/// both key off `kind` directly).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CanisterInfo {
    pub id: String,
    pub kind: CanisterKind,
}

/// One tool call the orchestration agent made, kept for observability via
/// `GET /jobs/:id`.
#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    pub at: chrono::DateTime<chrono::Utc>,
    pub tool: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: String,
    pub request: String,
    pub network: String,
    /// Principal that authenticated the `POST /orchestrate` call which created
    /// this job (the anonymous principal if `REQUIRE_AUTH=false`). `GET
    /// /jobs/:id` only lets this principal read the job back - see
    /// `routes/jobs.rs`.
    pub requested_by: String,
    pub state: JobState,
    /// Set exactly when `state == AwaitingAnswer` - the question `ask_user`
    /// posed, for `GET /jobs/:id` to display. Cleared once answered (or
    /// once the wait times out) alongside the state change back to
    /// `Running` - see `Job::ask`/`Job::resume`.
    pub pending_question: Option<String>,
    pub log: Vec<LogEntry>,
    /// Legacy single-canister result field - always `None` for the
    /// building-block flow (a job can produce several canisters now, see
    /// `canisters` below); still set by the older, separate
    /// `deploy_marketplace_item` path, which really does only ever produce
    /// one.
    pub canister_id: Option<String>,
    /// The real project name `scaffold_project` actually created (the
    /// requested name plus this job's own id - see `scaffold_project_tool`),
    /// once that step succeeds. `None` before then, or if this job never
    /// got that far.
    pub project_name: Option<String>,
    /// Canister name -> real identity (deployed principal + inferred
    /// building-block kind), for every canister this job has independently
    /// confirmed deployed so far - populated by
    /// `write_and_compile_project_tool`'s Mode-B success path from the same
    /// `verify_deployed_canister_ids` map it already checks, not from
    /// anything self-reported. A dashboard's real "which canisters does
    /// this project have, and what are they" data, once this flow actually
    /// reaches Mode B.
    pub canisters: std::collections::BTreeMap<String, CanisterInfo>,
    /// A single prose document giving an LLM agent (or a human) everything
    /// it needs to understand and operate this project without inspecting
    /// anything else first: the business requirement this job was given,
    /// every deployed canister's name/id/kind, and - for whichever
    /// canisters expose one - that canister's own `llm_context()` query
    /// verbatim (see `connector`/`agent`/`admin_agent`'s own
    /// `llm_context` methods). Generated once, right after `canisters`
    /// is populated (see `tools::generate_llm_context`) - `None` before
    /// then, or if this job never reached that point.
    pub llm_context: Option<String>,
    pub final_message: Option<String>,
    pub error: Option<String>,
    /// Running total of every LLM model call spent on this job - the
    /// top-level orchestration agent's own run plus every coding
    /// subagent's, folded in via `add_usage` as each `run_agent` call
    /// finishes (see `llm::AgentRunOutcome`). Zero for a field the
    /// provider never reported, not necessarily "no tokens used" - see
    /// `rig::completion::Usage::has_values`'s doc comment.
    pub token_usage: rig::completion::Usage,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,

    /// Not serialized: the job's private workspace directory on disk.
    #[serde(skip)]
    pub workspace_dir: PathBuf,
}

impl Job {
    pub fn new(id: String, request: String, network: String, requested_by: String, workspace_dir: PathBuf) -> Self {
        let now = chrono::Utc::now();
        Self {
            id,
            request,
            network,
            requested_by,
            state: JobState::Running,
            pending_question: None,
            log: Vec::new(),
            canister_id: None,
            project_name: None,
            canisters: std::collections::BTreeMap::new(),
            llm_context: None,
            final_message: None,
            error: None,
            token_usage: rig::completion::Usage::default(),
            created_at: now,
            updated_at: now,
            workspace_dir,
        }
    }

    /// Adds one `run_agent` call's usage to this job's running total -
    /// called once for the top-level agent's own run and once per
    /// coding-subagent `write_and_compile_project` call, so `token_usage`
    /// reflects every model call spent on this job, top-level and subagent
    /// combined. Called regardless of whether that run succeeded - see
    /// `llm::AgentRunOutcome`'s doc comment for why.
    pub fn add_usage(&mut self, usage: rig::completion::Usage) {
        self.token_usage += usage;
        self.updated_at = chrono::Utc::now();
    }

    /// Records the real project name `scaffold_project` created - see that
    /// field's own doc comment.
    pub fn set_project_name(&mut self, project_name: String) {
        self.project_name = Some(project_name);
        self.updated_at = chrono::Utc::now();
    }

    /// Merges newly independently-confirmed canister ids into this job's
    /// running set - see `canisters`'s own doc comment. Merges rather than
    /// replaces so an id confirmed on an earlier `write_and_compile_project`
    /// call (unlikely with the current one-Mode-B-call-per-job flow, but not
    /// assumed) is never lost. Each canister's `kind` is inferred from its
    /// name right here (`infer_canister_kind`), once, rather than
    /// re-inferred by every reader of `canisters`.
    pub fn add_canisters(&mut self, ids: impl IntoIterator<Item = (String, String)>) {
        self.canisters.extend(ids.into_iter().map(|(name, id)| {
            let kind = infer_canister_kind(&name);
            (name, CanisterInfo { id, kind })
        }));
        self.updated_at = chrono::Utc::now();
    }

    /// Records the generated project-wide LLM context document - see that
    /// field's own doc comment.
    pub fn set_llm_context(&mut self, context: String) {
        self.llm_context = Some(context);
        self.updated_at = chrono::Utc::now();
    }

    pub fn push_log(&mut self, tool: impl Into<String>, detail: impl Into<String>) {
        self.log.push(LogEntry {
            at: chrono::Utc::now(),
            tool: tool.into(),
            detail: detail.into(),
        });
        self.updated_at = chrono::Utc::now();
        // Tool logs can carry raw compiler output; keep the in-memory job bounded.
        const MAX_LOG_ENTRIES: usize = 200;
        if self.log.len() > MAX_LOG_ENTRIES {
            let excess = self.log.len() - MAX_LOG_ENTRIES;
            self.log.drain(0..excess);
        }
    }

    pub fn succeed(&mut self, canister_id: Option<String>, final_message: String) {
        self.state = JobState::Succeeded;
        self.pending_question = None;
        self.canister_id = canister_id;
        self.final_message = Some(final_message);
        self.updated_at = chrono::Utc::now();
    }

    pub fn fail(&mut self, error: String) {
        self.state = JobState::Failed;
        self.pending_question = None;
        self.error = Some(error);
        self.updated_at = chrono::Utc::now();
    }

    /// Pauses the job pending a human's answer to `question` - see
    /// `llm/codetools.rs::ask_user_tool`, the only caller.
    pub fn ask(&mut self, question: String) {
        self.state = JobState::AwaitingAnswer;
        self.pending_question = Some(question);
        self.updated_at = chrono::Utc::now();
    }

    /// Reverses `ask` - back to `Running`, whether an answer actually
    /// arrived or the wait simply timed out (the caller logs which
    /// happened; this method only restores the state machine).
    pub fn resume(&mut self) {
        self.state = JobState::Running;
        self.pending_question = None;
        self.updated_at = chrono::Utc::now();
    }
}

pub type JobHandle = Arc<Mutex<Job>>;

/// `jobs` and `pending_answers` are two independent maps, not one - a
/// `oneshot::Sender<String>` is neither `Clone` nor `Serialize`, so it can't
/// live on `Job` itself (which is both, for `GET /jobs/:id` and for the
/// snapshot-then-serialize pattern that endpoint uses). Keying the second
/// map by the same job id keeps the two in sync without coupling their
/// types together.
#[derive(Clone, Default)]
pub struct JobStore {
    jobs: Arc<Mutex<HashMap<String, JobHandle>>>,
    pending_answers: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl JobStore {
    pub fn insert(&self, job: Job) -> JobHandle {
        let handle: JobHandle = Arc::new(Mutex::new(job));
        self.jobs.lock().unwrap().insert(handle.lock().unwrap().id.clone(), handle.clone());
        handle
    }

    pub fn get(&self, id: &str) -> Option<JobHandle> {
        self.jobs.lock().unwrap().get(id).cloned()
    }

    /// Every job `requested_by` owns, newest first - the real data behind
    /// `GET /jobs` (`routes/jobs.rs::list_jobs`). A snapshot: each `Job` is
    /// cloned out from under its own lock, so a job still being worked on
    /// concurrently by `pipeline::run` shows up as it is right now, not a
    /// stale copy from whenever this call started iterating.
    pub fn list_for(&self, requested_by: &str) -> Vec<Job> {
        let mut jobs: Vec<Job> = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .map(|handle| handle.lock().unwrap().clone())
            .filter(|job| job.requested_by == requested_by)
            .collect();
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        jobs
    }

    /// Registers a new pending question for `job_id`, returning the
    /// receiver half - the caller (`ask_user_tool`) awaits this after
    /// calling `Job::ask`. Overwrites (silently drops) any previous pending
    /// sender for the same job id; that should never actually happen (a
    /// job's coding subagent asks at most one question at a time - each
    /// `ask_user` call awaits its own answer before the loop can call it
    /// again), but isn't itself a new failure mode to guard against here -
    /// the old receiver, if anyone were still awaiting it, would simply see
    /// its sender dropped and error out, the same as `submit_answer` failing.
    pub fn register_pending_answer(&self, job_id: &str) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.pending_answers.lock().unwrap().insert(job_id.to_string(), tx);
        rx
    }

    /// Delivers `answer` to whichever `ask_user` call is currently awaiting
    /// one for `job_id`. `Err` covers both "this job has no pending
    /// question at all" (never asked one, already answered, or its wait
    /// already timed out) and "it did, but the waiting side gave up already"
    /// (the receiver was dropped, e.g. its own timeout just fired) - both
    /// are reported identically, since from the caller's perspective (a
    /// human trying to answer) both mean "too late, this didn't go anywhere."
    pub fn submit_answer(&self, job_id: &str, answer: String) -> Result<(), String> {
        let sender = self.pending_answers.lock().unwrap().remove(job_id);
        let Some(sender) = sender else {
            return Err("this job has no pending question to answer".to_string());
        };
        sender.send(answer).map_err(|_| "the question timed out before this answer arrived".to_string())
    }

    /// Removes `job_id`'s pending sender without sending anything, if one
    /// exists - called by `ask_user_tool` after its own wait resolves
    /// (answered or timed out) so a slow-arriving `submit_answer` for the
    /// same id fails cleanly instead of silently vanishing into a receiver
    /// nothing is awaiting anymore.
    pub fn clear_pending_answer(&self, job_id: &str) {
        self.pending_answers.lock().unwrap().remove(job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str) -> Job {
        Job::new(id.to_string(), "request".to_string(), "local".to_string(), "requester".to_string(), PathBuf::new())
    }

    #[test]
    fn list_for_returns_only_the_caller_s_own_jobs_newest_first() {
        let store = JobStore::default();
        let mut older = Job::new("a".to_string(), "req a".to_string(), "local".to_string(), "alice".to_string(), PathBuf::new());
        older.created_at = chrono::Utc::now() - chrono::Duration::seconds(10);
        store.insert(older);
        store.insert(Job::new("b".to_string(), "req b".to_string(), "local".to_string(), "alice".to_string(), PathBuf::new()));
        store.insert(Job::new("c".to_string(), "req c".to_string(), "local".to_string(), "bob".to_string(), PathBuf::new()));

        let alices = store.list_for("alice");
        assert_eq!(alices.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"], "newest first, bob's job excluded");

        let bobs = store.list_for("bob");
        assert_eq!(bobs.len(), 1);
        assert_eq!(bobs[0].id, "c");

        assert!(store.list_for("carol").is_empty());
    }

    #[test]
    fn set_project_name_and_add_canisters_accumulate() {
        let mut j = job("a");
        assert_eq!(j.project_name, None);
        j.set_project_name("flight-booking-a1b2c3d4".to_string());
        assert_eq!(j.project_name.as_deref(), Some("flight-booking-a1b2c3d4"));

        j.add_canisters([("connector".to_string(), "aaaaa-aa".to_string())]);
        j.add_canisters([("agent".to_string(), "bbbbb-bb".to_string())]);
        assert_eq!(j.canisters.get("connector").map(|c| c.id.as_str()), Some("aaaaa-aa"));
        assert_eq!(j.canisters.get("connector").map(|c| c.kind), Some(CanisterKind::Connector));
        assert_eq!(j.canisters.get("agent").map(|c| c.id.as_str()), Some("bbbbb-bb"));
        assert_eq!(j.canisters.get("agent").map(|c| c.kind), Some(CanisterKind::Agent));
        assert_eq!(j.canisters.len(), 2);
    }

    #[test]
    fn set_llm_context_records_the_generated_document() {
        let mut j = job("a");
        assert_eq!(j.llm_context, None);
        j.set_llm_context("# flight-booking-a1b2c3d4\n\n...".to_string());
        assert!(j.llm_context.as_deref().unwrap().starts_with("# flight-booking"));
    }

    #[test]
    fn infer_canister_kind_matches_every_real_building_block_name() {
        assert_eq!(infer_canister_kind("connector"), CanisterKind::Connector);
        assert_eq!(infer_canister_kind("agent"), CanisterKind::Agent);
        assert_eq!(infer_canister_kind("admin_agent"), CanisterKind::AdminAgent);
        assert_eq!(infer_canister_kind("auth"), CanisterKind::Auth);
        assert_eq!(infer_canister_kind("ic-sql"), CanisterKind::Database);
        assert_eq!(infer_canister_kind("ic-pgsql"), CanisterKind::Database, "pre-rename alias must keep working");
        assert_eq!(infer_canister_kind("ic-kv"), CanisterKind::Database);
        assert_eq!(infer_canister_kind("vector_db"), CanisterKind::Database);
        assert_eq!(infer_canister_kind("analytics"), CanisterKind::Analytics);
        assert_eq!(infer_canister_kind("static"), CanisterKind::Static);
        assert_eq!(infer_canister_kind("assets"), CanisterKind::Static);
        assert_eq!(infer_canister_kind("backend"), CanisterKind::Other);
        assert_eq!(infer_canister_kind("some_custom_name"), CanisterKind::Other);
    }

    #[test]
    fn ask_moves_to_awaiting_answer_and_records_the_question() {
        let mut j = job("a");
        j.ask("what should the retry limit be?".to_string());
        assert_eq!(j.state, JobState::AwaitingAnswer);
        assert_eq!(j.pending_question.as_deref(), Some("what should the retry limit be?"));
    }

    #[test]
    fn resume_clears_the_question_and_returns_to_running_regardless_of_prior_state() {
        let mut j = job("a");
        j.ask("q".to_string());
        j.resume();
        assert_eq!(j.state, JobState::Running);
        assert_eq!(j.pending_question, None);
    }

    #[test]
    fn add_usage_accumulates_across_several_calls() {
        let mut j = job("a");
        let first = rig::completion::Usage { input_tokens: 100, output_tokens: 20, total_tokens: 120, ..Default::default() };
        let second = rig::completion::Usage { input_tokens: 50, output_tokens: 5, total_tokens: 55, ..Default::default() };

        j.add_usage(first);
        j.add_usage(second);

        assert_eq!(j.token_usage.input_tokens, 150);
        assert_eq!(j.token_usage.output_tokens, 25);
        assert_eq!(j.token_usage.total_tokens, 175);
    }

    #[test]
    fn succeed_and_fail_clear_a_pending_question_if_one_was_set() {
        let mut j = job("a");
        j.ask("q".to_string());
        j.succeed(Some("canister-id".to_string()), "done".to_string());
        assert_eq!(j.pending_question, None);

        let mut j = job("b");
        j.ask("q".to_string());
        j.fail("boom".to_string());
        assert_eq!(j.pending_question, None);
    }

    #[tokio::test]
    async fn submit_answer_delivers_to_the_matching_registered_receiver() {
        let store = JobStore::default();
        let receiver = store.register_pending_answer("job-1");
        store.submit_answer("job-1", "42".to_string()).expect("should deliver");
        assert_eq!(receiver.await.unwrap(), "42");
    }

    #[test]
    fn submit_answer_without_a_registered_question_fails_clearly() {
        let store = JobStore::default();
        let err = store.submit_answer("no-such-job", "answer".to_string()).unwrap_err();
        assert!(err.contains("no pending question"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn submit_answer_after_the_receiver_was_dropped_fails_clearly() {
        let store = JobStore::default();
        let receiver = store.register_pending_answer("job-1");
        drop(receiver); // simulates ask_user_tool's own timeout firing first
        let err = store.submit_answer("job-1", "too late".to_string()).unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }

    #[test]
    fn clear_pending_answer_makes_a_later_submit_answer_fail_cleanly() {
        let store = JobStore::default();
        let _receiver = store.register_pending_answer("job-1");
        store.clear_pending_answer("job-1");
        assert!(store.submit_answer("job-1", "late".to_string()).is_err());
    }

    #[tokio::test]
    async fn a_second_registration_for_the_same_job_replaces_the_first() {
        let store = JobStore::default();
        let first = store.register_pending_answer("job-1");
        let second = store.register_pending_answer("job-1");
        store.submit_answer("job-1", "for the second one".to_string()).unwrap();
        assert_eq!(second.await.unwrap(), "for the second one");
        // The first receiver's sender was silently dropped when overwritten -
        // it should observe that as a closed channel, not hang forever.
        assert!(first.await.is_err());
    }
}
