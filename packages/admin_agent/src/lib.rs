//! `admin_agent`: a **template** for an administrative-actions canister -
//! the trusted counterpart to `agent`. Where `agent`
//! goes out of its way to keep an LLM from ever directly performing
//! anything privileged, this canister *is* the privileged side: every
//! action it exposes is gated on the caller being a real, IC-authenticated
//! admin principal (`Config.admins`, or a controller), and once past that
//! gate, both a human (via a direct candid call from a frontend) and an AI
//! assistant (via `chat`'s tool-calling loop, on that same admin's behalf)
//! can invoke the same underlying actions.
//!
//! ## Why every action is logged
//!
//! Because this canister's whole reason to exist is letting privileged
//! operations happen, an audit trail of who did what and when is not
//! optional - see `state::log_action` and `list_action_log`/
//! `get_action_log`. Every example action in `tools.rs` logs itself before
//! returning success; keep that when you add your own.
//!
//! ## The two ways to call an action
//!
//! 1. **Directly**, as an ordinary candid method (e.g. `issue_refund`) - for
//!    a frontend with buttons/forms, or any other structured caller.
//! 2. **Through `chat`**, which runs the LLM/tool-calling loop
//!    (`llm::run_agent_loop`) over a caller-supplied conversation and
//!    returns the updated conversation - for a natural-language admin
//!    assistant. `chat` is stateless: nothing about the conversation is
//!    persisted here (unlike `agent`'s per-customer history) - the
//!    caller keeps the returned message list and sends it back, with their
//!    next message appended, to continue. That keeps this "simple sample"
//!    small; a deployment wanting server-side conversation history could
//!    add the same `SessionKey`-keyed storage pattern `agent`
//!    uses, keyed by admin principal instead.
//!
//! Both paths call the exact same underlying function per action
//! (`tools.rs`) and are gated by the exact same `require_admin` check - see
//! `tools.rs`'s doc comment for why giving tools free rein over an
//! arbitrary target (an order id, a customer reference) is fine here but
//! would not be in `agent`.

mod config;
mod llm;
mod messages;
mod state;
mod tools;

// Re-exported so integration tests (`tests/admin_agent_tests.rs`) can
// encode/decode candid calls against real Rust types.
pub use config::{Config, ConfigUpdate};
pub use messages::{ChatTurn, Role};
pub use state::ActionLogEntry;

use candid::Principal;

/// A controller may always call any gated method here, in addition to
/// whichever principals `Config.admins` names - useful for testing and for
/// bootstrapping a deployment before any admin has been configured yet.
fn require_admin() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err("anonymous caller not allowed".to_string());
    }
    if ic_cdk::api::is_controller(&caller) {
        return Ok(());
    }
    if state::get_config().admins.contains(&caller) {
        return Ok(());
    }
    Err("caller is not an authorized admin".to_string())
}

fn require_controller() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err("only a controller may call this method".to_string())
    }
}

#[ic_cdk::init]
fn init(config: Config) {
    state::set_config(config);
}

// ---------------------------------------------------------------------------
// Direct candid methods - one per action, for a frontend to call directly.
// See `tools.rs` for the shared logic these wrap.
// ---------------------------------------------------------------------------

#[ic_cdk::update]
fn issue_refund(order_id: String, amount_cents: u64, reason: String) -> Result<String, String> {
    require_admin()?;
    Ok(tools::issue_refund_action(order_id, amount_cents, reason))
}

#[ic_cdk::update]
fn set_account_status(customer_ref: String, status: String) -> Result<String, String> {
    require_admin()?;
    tools::set_account_status_action(customer_ref, status)
}

// ---------------------------------------------------------------------------
// chat: the same actions, via an LLM tool-calling loop
// ---------------------------------------------------------------------------

/// Runs one round of conversation: sends `history` plus `prompt` (prefixed
/// with the configured system prompt) to the LLM, executes any tool calls
/// via the same functions the direct methods above call, and returns the
/// full updated conversation (`history` plus a `User` turn for `prompt` and
/// an `Assistant` turn for the reply) - see this module's doc comment for
/// why this is stateless and what that means for callers: keep the
/// returned list and pass it back as `history` (with your next message as
/// `prompt`) to continue.
#[ic_cdk::update]
async fn chat(history: Vec<ChatTurn>, prompt: String) -> Result<Vec<ChatTurn>, String> {
    require_admin()?;
    let config = state::get_config();
    let rig_history: Vec<ic_rig::Message> = history.iter().map(ic_rig::Message::from).collect();
    let reply = llm::run_agent_loop(&config, rig_history, &prompt).await?;

    let mut updated = history;
    updated.push(ChatTurn { role: Role::User, content: prompt });
    updated.push(ChatTurn { role: Role::Assistant, content: reply });
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Configuration (controller-only)
// ---------------------------------------------------------------------------

#[ic_cdk::update]
fn update_config(update: ConfigUpdate) -> Result<(), String> {
    require_controller()?;
    state::set_config(state::get_config().apply(update));
    Ok(())
}

#[ic_cdk::query]
fn get_config() -> Result<Config, String> {
    require_controller()?;
    Ok(state::get_config())
}

// ---------------------------------------------------------------------------
// Audit log (admin-only - not controller-only: an admin should be able to
// see the record of what's been done, same as they can do the actions)
// ---------------------------------------------------------------------------

/// Newest-first, paginated.
#[ic_cdk::query]
fn list_action_log(offset: u64, limit: u64) -> Result<Vec<ActionLogEntry>, String> {
    require_admin()?;
    Ok(state::list_action_log(offset, limit))
}

// ---------------------------------------------------------------------------
// Agent discoverability
// ---------------------------------------------------------------------------

/// See `connector::llm_context`/`agent::llm_context`'s identical
/// reasoning: open to any caller, since there's nothing sensitive in a
/// description of this canister's own shape, and an agent needs to be able
/// to read this before it has any credentials to call anything else here.
#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

ic_cdk::export_candid!();
