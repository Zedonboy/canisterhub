//! The ticket escalation boundary - **this is the mechanism that keeps every
//! privileged action out of the LLM's direct reach.** See `tools.rs`'s doc
//! comment for the customer-tool side of this line; this module is the other
//! side of it.
//!
//! The flow:
//! 1. The model calls the reserved `request_admin_action` tool
//!    (`tools::RequestAdminActionTool`), whose parameters are just
//!    `action_type`/`details` - free text describing *what's wanted*, never
//!    anything that *performs* it.
//! 2. [`file_and_notify`] records the request as a ticket and pushes a
//!    notification to the project's operators.
//! 3. A human operator handles it from the inbox and marks it complete
//!    (`complete_admin_request`).
//!
//! At no point does this canister decide, on the model's say-so, to actually
//! perform a refund, delete an account, or do anything else with real
//! consequence - it only ever files a ticket.

use crate::messages::{AdminRequest, AdminRequestStatus, SessionKey};
/// Handles the model's `request_admin_action` tool call
/// (`tools::RequestAdminActionTool::call` delegates straight here) - see
/// this module's doc comment for the full flow. Called both from that tool
/// (the normal path) and from `llm::run_agent_loop`'s iteration-exhaustion
/// fallback (see that function's doc comment) - a plain function taking
/// typed arguments rather than anything tool-call-shaped, since both
/// callers already have `action_type`/`details` as plain strings.
pub async fn file_and_notify(
    customer: &SessionKey,
    action_type: &str,
    details: &str,
) -> Result<String, String> {
    let config = crate::state::get_config();

    let now = ic_cdk::api::time();
    let id = crate::state::next_admin_request_id();
    let request = AdminRequest {
        id,
        channel: customer.channel,
        session_id: customer.session_id.clone(),
        action_type: action_type.to_string(),
        details: details.to_string(),
        status: AdminRequestStatus::Pending,
        result_message: None,
        created_at: now,
        updated_at: now,
    };
    crate::state::insert_admin_request(request.clone());

    // Notify project operators through the protocol's project-scoped Web Push
    // gateway. The ticket is persisted first; delivery is best-effort and
    // must not prevent the customer from receiving the ticket reference.
    crate::protocol::notify_owner(
        &config,
        "New support ticket",
        &format!("Ticket #{id}: {action_type}"),
        "/inbox#tickets",
    )
    .await;

    Ok(format!("Your request has been filed (reference #{id}) and forwarded to our team. We'll follow up as soon as possible."))
}
