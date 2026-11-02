//! Administrative actions, each exposed **two ways**: a plain candid method
//! (for a frontend a human admin uses directly, see `lib.rs`) and an LLM
//! tool (`ic_rig::Tool`, for `chat`'s tool-calling loop, see `llm.rs`) -
//! both calling the same underlying function, so there is exactly one
//! implementation of each action's actual logic and its audit-logging
//! behavior to keep in sync, not two.
//!
//! # Why this is safe here but not in `agent`
//!
//! `agent`'s tools (see that canister's `tools.rs`) are
//! deliberately barred from taking any kind of identity/account parameter,
//! because *any* untrusted customer conversation can drive them - the only
//! thing making that safe is that they're scoped to "whoever is talking"
//! and nothing else.
//!
//! Here, the opposite: every tool below **does** take a target identifier
//! (an order id, a customer reference) as a parameter, because that's the
//! entire point of an administrative action - it operates on someone other
//! than the caller. That's only safe because the caller is never an
//! arbitrary conversation partner: both entry points (the direct candid
//! method and `chat`) are gated by `require_admin` in `lib.rs`, checking the
//! *real, IC-authenticated* caller principal against `Config.admins` (or
//! controller status) - not anything a model could talk its way around.
//! The LLM here is a convenience layer for an already-privileged caller,
//! not a boundary keeping an untrusted one out.
//!
//! # Adding your own action
//!
//! 1. Write the actual logic as a plain function that takes typed
//!    arguments and returns `Result<String, String>` (or `String` if it
//!    can't fail), and have it call
//!    `state::log_action(ic_cdk::api::msg_caller(), "your_action_name", "...")`
//!    before returning `Ok` - see `issue_refund`/`set_account_status`
//!    below. This repo's `icrc-ledger` skill is the place to start if your
//!    action should actually move funds rather than just record that it
//!    did (see `issue_refund`'s comment).
//! 2. Add a plain candid method for it in `lib.rs`, gated by
//!    `require_admin()?`, that just calls your function.
//! 3. Define an `Args` struct (`#[derive(serde::Deserialize)]`) and
//!    implement `ic_rig::Tool` for a small marker struct (see
//!    `IssueRefundTool` below), whose `call()` parses `args` and calls the
//!    same function. Register it in `llm::run_agent_loop`'s
//!    `.tool(YourTool)` chain.

use ic_rig::{Tool, ToolDefinition};
use serde::Deserialize;
use serde_json::json;

/// Shared error type - `ic_rig::Tool::Error` must implement
/// `std::error::Error`, which a bare `String` doesn't.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ActionError(pub String);

impl From<String> for ActionError {
    fn from(s: String) -> Self {
        ActionError(s)
    }
}

// ---------------------------------------------------------------------------
// Example actions - replace these with your own business's administrative
// operations. Both are stubs that record the action without touching any
// real payments/account system, deliberately - wiring either up to
// something real (an ICRC ledger transfer for the refund, a call to
// whatever canister owns account state for the status change) is a
// business-specific integration this "simple sample" leaves to you.
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES: [&str; 3] = ["active", "suspended", "banned"];

fn validate_status(status: &str) -> Result<(), String> {
    if ALLOWED_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(format!(
            "status must be one of {ALLOWED_STATUSES:?}, got '{status}'"
        ))
    }
}

fn issue_refund(order_id: &str, amount_cents: u64, reason: &str) -> String {
    // A real implementation would transfer funds here - see this project's
    // `icrc-ledger` skill for ICRC-1/2 transfers, or whatever payment
    // processor's API your business already uses.
    let admin = ic_cdk::api::msg_caller();
    let details = format!("order_id={order_id} amount_cents={amount_cents} reason={reason}");
    crate::state::log_action(admin, "issue_refund", &details);
    format!("Refund of {amount_cents} cents issued for order '{order_id}' (reason: {reason}).")
}

fn set_account_status(customer_ref: &str, status: &str) -> String {
    // A real implementation would call whatever canister/service owns
    // account state here. `status` is assumed already validated
    // (`validate_status`) by every caller of this function.
    let admin = ic_cdk::api::msg_caller();
    let details = format!("customer_ref={customer_ref} status={status}");
    crate::state::log_action(admin, "set_account_status", &details);
    format!("Account '{customer_ref}' status set to '{status}'.")
}

/// Candid-method wrapper `lib.rs` exposes directly.
pub fn issue_refund_action(order_id: String, amount_cents: u64, reason: String) -> String {
    issue_refund(&order_id, amount_cents, &reason)
}

/// Candid-method wrapper `lib.rs` exposes directly.
pub fn set_account_status_action(customer_ref: String, status: String) -> Result<String, String> {
    validate_status(&status)?;
    Ok(set_account_status(&customer_ref, &status))
}

// ---------------------------------------------------------------------------
// ic_rig::Tool adapters - one per action, for `chat`'s tool-calling loop.
// ---------------------------------------------------------------------------

pub struct IssueRefundTool;

#[derive(Deserialize)]
pub struct IssueRefundArgs {
    order_id: String,
    amount_cents: u64,
    reason: String,
}

impl Tool for IssueRefundTool {
    const NAME: &'static str = "issue_refund";
    type Error = ActionError;
    type Args = IssueRefundArgs;
    type Output = String;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Issue a refund for an order.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "order_id": { "type": "string", "description": "The order to refund." },
                    "amount_cents": { "type": "number", "description": "Refund amount in cents." },
                    "reason": { "type": "string", "description": "Why this refund is being issued." }
                },
                "required": ["order_id", "amount_cents", "reason"]
            }),
        }
    }

    async fn call(&self, args: IssueRefundArgs) -> Result<String, ActionError> {
        Ok(issue_refund(
            &args.order_id,
            args.amount_cents,
            &args.reason,
        ))
    }
}

pub struct SetAccountStatusTool;

#[derive(Deserialize)]
pub struct SetAccountStatusArgs {
    customer_ref: String,
    status: String,
}

impl Tool for SetAccountStatusTool {
    const NAME: &'static str = "set_account_status";
    type Error = ActionError;
    type Args = SetAccountStatusArgs;
    type Output = String;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Set a customer account's status (active, suspended, or banned)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "customer_ref": { "type": "string", "description": "The customer account to update." },
                    "status": { "type": "string", "description": "One of: active, suspended, banned." }
                },
                "required": ["customer_ref", "status"]
            }),
        }
    }

    async fn call(&self, args: SetAccountStatusArgs) -> Result<String, ActionError> {
        validate_status(&args.status)?;
        Ok(set_account_status(&args.customer_ref, &args.status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The success path for both tools (which reaches `issue_refund`/
    // `set_account_status` and therefore `ic_cdk::api::msg_caller()` via
    // `state::log_action`) is exercised by `tests/admin_agent_tests.rs`
    // (PocketIC) instead - `ic_cdk::api::msg_caller()` traps outside a real
    // canister execution, so these tests stick to what's pure: argument
    // validation and the error paths that never reach it.

    #[test]
    fn validate_status_accepts_every_known_status_and_rejects_others() {
        for status in ALLOWED_STATUSES {
            assert!(validate_status(status).is_ok());
        }
        assert!(validate_status("on-fire").is_err());
    }

    #[tokio::test]
    async fn set_account_status_tool_rejects_unknown_status_before_touching_state() {
        let tool = SetAccountStatusTool;
        let result = tool
            .call(SetAccountStatusArgs {
                customer_ref: "cust-1".to_string(),
                status: "on-fire".to_string(),
            })
            .await;
        assert!(result.is_err());
    }

    #[test]
    fn tool_definitions_declare_the_documented_parameters() {
        let refund_params = IssueRefundTool.definition().parameters;
        let required = refund_params["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "order_id"));
        assert!(required.iter().any(|v| v == "amount_cents"));
        assert!(required.iter().any(|v| v == "reason"));

        let status_params = SetAccountStatusTool.definition().parameters;
        let required = status_params["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "customer_ref"));
        assert!(required.iter().any(|v| v == "status"));
    }
}
