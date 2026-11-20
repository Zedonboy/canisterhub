//! Caller-funded cycles for endpoints that make HTTPS outcalls or paid
//! inter-canister calls.
//!
//! Canister callers attach the cycles to the call. An endpoint first checks
//! `check(required)` so an under-funded call fails before any work is done,
//! then `accept(required)` right before the outcall. Only `required` is ever
//! accepted; the system refunds whatever the caller attached beyond that.

use ic_cdk_management_canister::{cost_http_request, HttpHeader, HttpMethod, HttpRequestArgs};

/// Extra headroom over the computed outcall price so small pricing drift
/// (subnet size changes) does not make the backend subsidise the call.
const MARGIN_PERCENT: u128 = 10;

fn with_margin(cycles: u128) -> u128 {
    cycles.saturating_add(cycles / 100 * MARGIN_PERCENT)
}

/// Price of one non-replicated HTTPS POST with the given request and response
/// bounds, matching what `http_request` will attach from the backend's balance.
pub fn http_outcall_cost(
    url_bytes: usize,
    header_bytes: usize,
    body_bytes: usize,
    max_response_bytes: u64,
) -> u128 {
    let args = HttpRequestArgs {
        url: "u".repeat(url_bytes),
        method: HttpMethod::POST,
        headers: vec![HttpHeader {
            name: String::new(),
            value: "h".repeat(header_bytes),
        }],
        body: Some(vec![0; body_bytes]),
        max_response_bytes: Some(max_response_bytes),
        transform: None,
        is_replicated: Some(false),
    };
    with_margin(cost_http_request(&args))
}

/// Fails fast, without accepting anything, when the call did not attach at
/// least `required` cycles.
pub fn check(required: u128) -> Result<(), String> {
    let attached = ic_cdk::api::msg_cycles_available();
    if attached < required {
        return Err(format!(
            "insufficient cycles attached: this call requires {required} cycles but {attached} were attached"
        ));
    }
    Ok(())
}

/// Takes exactly `required` cycles from the call into the backend's balance.
pub fn accept(required: u128) -> Result<(), String> {
    let accepted = ic_cdk::api::msg_cycles_accept(required);
    if accepted < required {
        return Err(format!(
            "insufficient cycles attached: this call requires {required} cycles but only {accepted} could be accepted"
        ));
    }
    Ok(())
}
