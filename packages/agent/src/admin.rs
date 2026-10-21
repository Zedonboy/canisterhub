//! The administrative escalation boundary - **this is the mechanism that
//! keeps every privileged action out of the LLM's direct reach.** See
//! `tools.rs`'s doc comment for the customer-tool side of this line;
//! this module is the other side of it.
//!
//! The flow, end to end:
//! 1. The model calls the reserved `request_admin_action` tool
//!    (`tools::RequestAdminActionTool`), whose parameters are just
//!    `action_type`/`details` - free text describing *what's wanted*, never
//!    anything that *performs* it.
//! 2. [`file_and_notify`] records an [`AdminRequest`] and POSTs it to
//!    `Config.admin_webhook_url`, HMAC-signed with `admin_webhook_secret`
//!    so the receiving system can verify it really came from this canister.
//! 3. Whatever's on the other end of that webhook - a human support queue,
//!    a separate more-heavily-audited service, anything - decides what to
//!    actually do, entirely outside this canister's code and trust
//!    boundary.
//! 4. It calls back `POST /webhook/admin` (see `lib.rs`'s `http_request*`)
//!    with a resolution. [`handle_callback`] verifies that same shared
//!    secret, updates the `AdminRequest`, and hands the result back to
//!    `lib.rs` to relay to the customer via `connector.send_message`.
//!
//! At no point does this canister decide, on the model's say-so, to
//! actually perform a refund, delete an account, or do anything else with
//! real consequence - it only ever files a request and later relays
//! whatever the external system decided.

use crate::messages::{AdminRequest, AdminRequestStatus, SessionKey};
use hmac::{Hmac, Mac};
use sha2::Sha256;

const ADMIN_WEBHOOK_MAX_RESPONSE_BYTES: u64 = 4_096;

/// Handles the model's `request_admin_action` tool call
/// (`tools::RequestAdminActionTool::call` delegates straight here) - see
/// this module's doc comment for the full flow. Called both from that tool
/// (the normal path) and from `llm::run_agent_loop`'s iteration-exhaustion
/// fallback (see that function's doc comment) - a plain function taking
/// typed arguments rather than anything tool-call-shaped, since both
/// callers already have `action_type`/`details` as plain strings.
pub async fn file_and_notify(customer: &SessionKey, action_type: &str, details: &str) -> Result<String, String> {
    let config = crate::state::get_config();
    let Some(webhook_url) = config.admin_webhook_url.clone() else {
        return Err("administrative escalation is not configured for this deployment - a controller must set admin_webhook_url".to_string());
    };

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

    // Best-effort: the request is already durably recorded and the customer
    // is about to be told it was filed either way - a controller can always
    // see it via `list_admin_requests` and re-notify out of band if this
    // particular delivery attempt failed. Failing the customer's whole
    // conversation turn over a delivery hiccup would be a worse outcome
    // than a delayed notification.
    if let Some(secret) = config.admin_webhook_secret.clone() {
        if let Err(e) = notify_admin_webhook(&webhook_url, &secret, &request).await {
            ic_cdk::api::debug_print(format!("agent: failed to notify admin webhook for request #{id}: {e}"));
        }
    } else {
        ic_cdk::api::debug_print(format!("agent: admin_webhook_secret is not configured - sent request #{id} unsigned is not possible, skipping notification"));
    }

    Ok(format!("Your request has been filed (reference #{id}) and forwarded to our team. We'll follow up as soon as possible."))
}

fn admin_request_payload(request: &AdminRequest) -> serde_json::Value {
    serde_json::json!({
        "request_id": request.id,
        "channel": format!("{:?}", request.channel),
        "session_id": request.session_id,
        "action_type": request.action_type,
        "details": request.details,
        "created_at": request.created_at,
    })
}

async fn notify_admin_webhook(url: &str, secret: &str, request: &AdminRequest) -> Result<(), String> {
    use ic_cdk_management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};

    let body = admin_request_payload(request).to_string().into_bytes();
    let signature = sign_hex(secret, &body);

    let arg = HttpRequestArgs {
        url: format!("{}/admin/requests", url.trim_end_matches('/')),
        method: HttpMethod::POST,
        max_response_bytes: Some(ADMIN_WEBHOOK_MAX_RESPONSE_BYTES),
        headers: vec![
            HttpHeader { name: "Content-Type".to_string(), value: "application/json".to_string() },
            HttpHeader { name: "X-Signature".to_string(), value: format!("sha256={signature}") },
        ],
        body: Some(body),
        // See `connector/src/outbound.rs`'s doc comment for why every
        // outbound send in this project uses a single replica rather than
        // the default replicated-and-reconciled outcall: notifying an
        // administrative system is a one-time real-world side effect, not
        // something that should happen once per replica on the subnet.
        transform: None,
        is_replicated: Some(false),
    };

    let response = http_request(&arg).await.map_err(|e| format!("outcall failed: {e:?}"))?;
    if response.status != 200u32 {
        return Err(format!("admin webhook returned status {}", response.status));
    }
    Ok(())
}

/// The body `POST /webhook/admin` (see `lib.rs`) expects.
#[derive(serde::Deserialize)]
pub struct AdminCallback {
    pub request_id: u64,
    /// `"approved"`, `"rejected"`, or `"completed"` (case-insensitive) -
    /// anything else is rejected rather than guessed at.
    pub status: String,
    /// Relayed back to the customer verbatim - see `handle_callback`'s doc
    /// comment for why this canister doesn't run it back through the LLM.
    pub message: String,
}

/// Verifies `POST /webhook/admin`'s `X-Signature` header (same HMAC-SHA256
/// scheme `notify_admin_webhook` signs with, over the raw body, keyed by the
/// same `admin_webhook_secret`) and applies the callback if it checks out.
/// Returns the updated request - `lib.rs` relays `result_message` to the
/// customer via `connector.send_message`.
///
/// `result_message` is sent to the customer exactly as the external system
/// wrote it, not re-run through the LLM for rephrasing: doing that would
/// mean feeding admin-originated text back into the same tool-calling loop
/// that customer messages go through, reopening a path for the model to
/// call tools (including, in principle, `request_admin_action` again) in
/// response to content this canister did not receive from the customer -
/// a confusion of trust boundaries this template avoids by simply never
/// letting admin-callback content reach the model at all.
pub fn handle_callback(body: &[u8], signature_header: Option<&str>) -> Result<AdminRequest, String> {
    let config = crate::state::get_config();
    let secret = config.admin_webhook_secret.as_deref().ok_or("admin_webhook_secret is not configured")?;
    if !verify_signature(body, signature_header, secret) {
        return Err("invalid signature".to_string());
    }

    let callback: AdminCallback = serde_json::from_slice(body).map_err(|e| format!("invalid callback body: {e}"))?;
    let status = match callback.status.to_ascii_lowercase().as_str() {
        "approved" => AdminRequestStatus::Approved,
        "rejected" => AdminRequestStatus::Rejected,
        "completed" => AdminRequestStatus::Completed,
        other => return Err(format!("unknown status '{other}' - expected approved/rejected/completed")),
    };

    let now = ic_cdk::api::time();
    crate::state::update_admin_request(callback.request_id, |req| {
        req.status = status;
        req.result_message = Some(callback.message.clone());
        req.updated_at = now;
    })?;

    crate::state::get_admin_request(callback.request_id).ok_or_else(|| format!("admin request #{} vanished after update", callback.request_id))
}

fn sign_hex(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

fn verify_signature(body: &[u8], signature_header: Option<&str>, secret: &str) -> bool {
    let Some(hex_sig) = signature_header.and_then(|h| h.strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(expected) = hex::decode(hex_sig) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_round_trips_and_rejects_tampering() {
        let secret = "shared-secret";
        let body = br#"{"request_id":1,"status":"approved","message":"ok"}"#;
        let sig = sign_hex(secret, body);
        let header = format!("sha256={sig}");

        assert!(verify_signature(body, Some(&header), secret));
        assert!(!verify_signature(b"tampered", Some(&header), secret));
        assert!(!verify_signature(body, Some(&header), "wrong-secret"));
        assert!(!verify_signature(body, None, secret));
        assert!(!verify_signature(body, Some("not-prefixed"), secret));
    }
}
