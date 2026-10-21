//! The customer-facing tool registry - **the single most important file in
//! this template to read before adapting it for a real business.**
//!
//! # The security invariant every tool must preserve
//!
//! Every tool struct here holds a `customer: SessionKey` field - *who this
//! conversation is with* - set once, by [`llm::run_agent_loop`], from where
//! the inbound message actually came from (`connector`'s own
//! `channel`/`session_id`, authenticated by `connector_principal` back in
//! `lib.rs::receive_message`). **A tool's `call` method must act only on
//! `self.customer`'s own data, and its `Args` type must never contain a
//! customer/account identifier.**
//!
//! This isn't a convention to remember - `ic_rig::Tool::call(&self, args: Self::Args)`
//! structurally has no other way to learn a customer identity: `args` is
//! deserialized from whatever JSON the model supplied (per each tool's own
//! schema, declared in `definition()`), and `self.customer` is set by the
//! dispatcher before the model ever runs, not by anything derived from its
//! output. A model that hallucinates or is prompt-injected into "wanting" to
//! act on a different customer has no field to put that in - every schema
//! below simply never declares one.
//!
//! This is the boundary that makes it safe to let an LLM call these tools
//! directly at all: worst case, a manipulated conversation can only affect
//! *its own* customer's *own* data - never another customer's, and never
//! anything administrative (see `admin.rs` and [`RequestAdminActionTool`]
//! for where that line is drawn and why it's a webhook, not a tool that
//! does anything by itself).
//!
//! # Adding your own tool
//!
//! 1. Define an `Args` struct (`#[derive(serde::Deserialize)]`) with only
//!    the *inputs* the action needs - never an identity field, per the
//!    invariant above - and an `Output` struct (`#[derive(serde::Serialize)]`)
//!    for what it returns.
//! 2. Define a struct holding `customer: SessionKey` (copy
//!    [`UpdateUsernameTool`]'s shape) and implement `ic_rig::Tool` for it:
//!    `NAME`, `Error` (`ActionError` below is fine for most), `Args`,
//!    `Output`, `definition()` (a JSON Schema - the model decides *when* to
//!    call a tool from this text, so be specific about what it does and
//!    does not do), and `call()` (your actual logic, scoped to
//!    `self.customer` only).
//! 3. Register it in [`llm::run_agent_loop`]'s `.tool(...)` chain, passing
//!    `YourTool { customer: customer.clone() }`.
//!
//! If the action you're adding is administrative rather than customer-
//! self-service (refunds, account bans, cross-customer lookups, anything
//! irreversible or requiring human judgment) - **do not** add it here.
//! Extend [`RequestAdminActionTool`]'s handling on the receiving end of the
//! webhook instead (see `admin.rs`'s doc comment).
//!
//! [`QueryDatabaseTool`] bends the "only ever touches `self.customer`'s own
//! data" rule above in one specific, deliberate way: an arbitrary SQL
//! database has no fixed "customer" column this file could filter by, so
//! instead of scoping *what* it can touch, it's restricted to *how* -
//! read-only, never a mutation. See that tool's own doc comment. If you add
//! a tool that needs to *write* to the database, call
//! [`crate::db::execute`] directly from that tool's own `call()` (see
//! `db.rs`'s doc comment for why it's a plain function, not a `Tool`
//! itself) - don't loosen `QueryDatabaseTool` to do it.

use crate::messages::SessionKey;
use candid::Principal;
use ic_rig::{Tool, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Shared error type for every tool in this file - `ic_rig::Tool::Error`
/// must implement `std::error::Error`, which a bare `String` doesn't.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ActionError(pub String);

impl From<String> for ActionError {
    fn from(s: String) -> Self {
        ActionError(s)
    }
}

// ---------------------------------------------------------------------------
// Example tools - replace these with your own business's actions. Each
// keys a customer profile record by `SessionKey` alone: whichever channel
// address is having this conversation *is* the account, for this template's
// purposes. A real business with a separate notion of "customer account"
// (e.g. one login shared across channels) should resolve `SessionKey` to
// that account id first - the invariant in this module's doc comment still
// applies to whatever key you resolve to: it must come from the
// authenticated session, never from a tool argument.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CustomerProfile {
    pub username: Option<String>,
    pub display_name: Option<String>,
}

pub struct GetProfileTool {
    pub customer: SessionKey,
}

#[derive(Deserialize)]
pub struct GetProfileArgs {}

#[derive(Serialize)]
pub struct GetProfileOutput {
    pub username: Option<String>,
    pub display_name: Option<String>,
}

impl Tool for GetProfileTool {
    const NAME: &'static str = "get_profile";
    type Error = ActionError;
    type Args = GetProfileArgs;
    type Output = GetProfileOutput;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get the current customer's own profile (username and display name). Takes no parameters - it always returns the profile of whoever is having this conversation.".to_string(),
            parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        }
    }

    async fn call(&self, _args: GetProfileArgs) -> Result<GetProfileOutput, ActionError> {
        let profile = crate::state::get_customer_profile(&self.customer);
        Ok(GetProfileOutput { username: profile.username, display_name: profile.display_name })
    }
}

pub struct UpdateUsernameTool {
    pub customer: SessionKey,
}

#[derive(Deserialize)]
pub struct UpdateUsernameArgs {
    new_username: String,
}

impl Tool for UpdateUsernameTool {
    const NAME: &'static str = "update_username";
    type Error = ActionError;
    type Args = UpdateUsernameArgs;
    type Output = String;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Change the current customer's own username to a new value they've asked for. Only affects the customer having this conversation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "new_username": { "type": "string", "description": "The new username, exactly as the customer wants it." }
                },
                "required": ["new_username"]
            }),
        }
    }

    async fn call(&self, args: UpdateUsernameArgs) -> Result<String, ActionError> {
        let new_username = args.new_username.trim();
        if new_username.is_empty() {
            return Err(ActionError("new_username must not be empty".to_string()));
        }
        if new_username.chars().count() > 32 {
            return Err(ActionError("new_username must be 32 characters or fewer".to_string()));
        }

        let mut profile = crate::state::get_customer_profile(&self.customer);
        profile.username = Some(new_username.to_string());
        crate::state::set_customer_profile(&self.customer, profile);
        Ok(format!("username updated to '{new_username}'"))
    }
}

// ---------------------------------------------------------------------------
// The database query tool - deliberately read-only, unlike `db.rs`'s
// underlying client, which also exposes `execute` (mutations). Letting a
// customer-facing model run arbitrary SQL against a shared database - not
// just its own row, the way `update_username` is scoped - is a materially
// different risk from this file's other tools, so it gets a materially
// different guard: not "can only touch this customer's own data" (there's
// no `customer` column this tool could filter by in an arbitrary schema),
// but "can only ever read, never write". A tool that needs to *write* to
// the database as part of its own logic should call `db::execute` directly
// from its own `call()` - not by loosening this tool - the same way
// `request_admin_action` routes anything requiring judgment through a human
// rather than letting the model act directly.
// ---------------------------------------------------------------------------

pub struct QueryDatabaseTool {
    /// Unlike every other tool in this file, `call()` below doesn't actually
    /// read this - there's no fixed "customer" column in an arbitrary SQL
    /// schema to scope by (see this struct's doc comment above). Kept
    /// anyway, rather than dropped, so this tool still matches every other
    /// one's shape (a reviewer checking "does every tool hold a `customer`
    /// field" doesn't need a special case) and so it's a small, obvious
    /// change to start using it - e.g. per-customer rate limiting, or
    /// logging who ran what - without restructuring the tool later.
    #[allow(dead_code)]
    pub customer: SessionKey,
    /// Not used to scope the query either, only to know *which* database to
    /// ask. Kept as a field (like every other tool's `customer`) rather
    /// than a global, so a test can construct this tool against a fake/
    /// missing canister id without touching real config state.
    pub ic_sql_canister_id: Option<Principal>,
}

#[derive(Deserialize)]
pub struct QueryDatabaseArgs {
    sql: String,
}

impl Tool for QueryDatabaseTool {
    const NAME: &'static str = "query_database";
    type Error = ActionError;
    type Args = QueryDatabaseArgs;
    type Output = crate::db::QueryResult;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Run a read-only SELECT against this business's database to answer a customer's question - e.g. product information, order status, or FAQs, depending on what this deployment's database holds. Read-only: cannot create, change, or delete anything (use update_username for this customer's own profile, or request_admin_action for anything needing a change or human judgment). Not automatically scoped to this customer - only query tables/columns appropriate to share with a customer, and never write a query that could expose another customer's data.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single read-only SELECT statement." }
                },
                "required": ["sql"]
            }),
        }
    }

    async fn call(&self, args: QueryDatabaseArgs) -> Result<crate::db::QueryResult, ActionError> {
        let canister_id = self
            .ic_sql_canister_id
            .ok_or_else(|| ActionError("no database is configured for this deployment (Config::ic_sql_canister_id is unset)".to_string()))?;
        crate::db::query(canister_id, &args.sql).await.map_err(ActionError)
    }
}

// ---------------------------------------------------------------------------
// The reserved escalation tool - keep this in every deployment of this
// template. See `admin.rs`'s doc comment for the full flow; this struct
// only adapts it to `ic_rig::Tool`'s shape.
// ---------------------------------------------------------------------------

pub struct RequestAdminActionTool {
    pub customer: SessionKey,
}

#[derive(Deserialize)]
pub struct RequestAdminActionArgs {
    action_type: String,
    details: String,
}

impl Tool for RequestAdminActionTool {
    const NAME: &'static str = "request_admin_action";
    type Error = ActionError;
    type Args = RequestAdminActionArgs;
    type Output = String;

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Escalate to a human/administrative system for anything you cannot do yourself: refunds, account deletion, disputes, complaints requiring judgment, or any request outside your other tools' scope. This does NOT perform the action - it only files a request and lets the customer know someone will follow up. Always prefer this over guessing or refusing outright when a request is legitimate but outside your other tools.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action_type": { "type": "string", "description": "A short category for the request, e.g. \"refund\", \"account_deletion\", \"complaint\", \"escalate\"." },
                    "details": { "type": "string", "description": "Everything a human would need to act on this: what the customer wants and why, in your own words." }
                },
                "required": ["action_type", "details"]
            }),
        }
    }

    async fn call(&self, args: RequestAdminActionArgs) -> Result<String, ActionError> {
        crate::admin::file_and_notify(&self.customer, &args.action_type, &args.details).await.map_err(ActionError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> SessionKey {
        SessionKey { channel: crate::messages::Channel::WhatsApp, session_id: id.to_string() }
    }

    /// The core invariant this module exists to enforce: every tool's JSON
    /// Schema (what the model can even populate) must never expose a
    /// parameter that looks like a customer/account identifier - that
    /// would give the model a way to *express* "act on someone else", even
    /// if handlers happen not to honor it today.
    #[test]
    fn no_tool_parameter_looks_like_a_customer_identifier() {
        let suspicious = ["customer_id", "customer", "user_id", "account_id", "session_id", "channel", "phone", "email"];
        let customer = key("probe");
        let defs = [
            GetProfileTool { customer: customer.clone() }.definition(),
            UpdateUsernameTool { customer: customer.clone() }.definition(),
            QueryDatabaseTool { customer: customer.clone(), ic_sql_canister_id: None }.definition(),
            RequestAdminActionTool { customer }.definition(),
        ];
        for def in defs {
            let Some(properties) = def.parameters.get("properties").and_then(|p| p.as_object()) else { continue };
            for name in properties.keys() {
                let lower = name.to_ascii_lowercase();
                assert!(!suspicious.contains(&lower.as_str()), "tool '{}' has a parameter '{}' that looks like a customer identifier - see tools.rs's doc comment", def.name, name);
            }
        }
    }

    #[tokio::test]
    async fn update_username_only_ever_touches_the_key_the_caller_supplied() {
        // A malicious/confused model has no field to name a *different*
        // customer in the first place (`UpdateUsernameArgs` has none) - this
        // is really a test that stays true by construction, kept as a
        // regression guard against a future edit adding one.
        let tool = UpdateUsernameTool { customer: key("alice") };
        tool.call(UpdateUsernameArgs { new_username: "alice2".to_string() }).await.unwrap();
        assert_eq!(crate::state::get_customer_profile(&key("alice")).username.as_deref(), Some("alice2"));
        assert_eq!(crate::state::get_customer_profile(&key("someone-else")).username, None, "a different customer's record must be untouched");
    }

    #[tokio::test]
    async fn update_username_rejects_empty_and_overlong_values() {
        let tool = UpdateUsernameTool { customer: key("bob") };
        assert!(tool.call(UpdateUsernameArgs { new_username: "".to_string() }).await.is_err());
        assert!(tool.call(UpdateUsernameArgs { new_username: "x".repeat(33) }).await.is_err());
    }

    #[tokio::test]
    async fn query_database_errors_clearly_when_no_database_is_configured() {
        // Must fail before ever attempting an inter-canister call - this
        // doesn't need PocketIC/a real ic-sql instance to verify.
        let tool = QueryDatabaseTool { customer: key("carol"), ic_sql_canister_id: None };
        let err = tool.call(QueryDatabaseArgs { sql: "SELECT 1".to_string() }).await.unwrap_err();
        assert!(err.0.contains("no database is configured"), "unexpected error: {}", err.0);
    }
}
