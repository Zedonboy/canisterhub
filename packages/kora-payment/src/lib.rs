//! Kora implementation of the shared CanisterHub Payment Provider API.
//!
//! Inventory canisters create a hosted charge through `create_charge`. Kora's
//! redirect and webhook endpoints both verify the transaction server-side
//! before calling the inventory canister recorded for that charge reference.

extern crate ic_cdk_020 as ic_cdk;

mod assets;
mod config;
mod state;

use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::ConfigValue;
use canister_hub_sdk::ProjectContext;
use hmac::{Hmac, Mac};
use ic_cdk_management_canister::{http_request as management_http_request, HttpHeader, HttpMethod, HttpRequestArgs};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

const KORA_API: &str = "https://api.korapay.com/merchant/api/v1";
const MAX_HTTP_RESPONSE: u64 = 32 * 1024;
const MAX_REFERENCE_BYTES: usize = 160;
const MAX_EMAIL_BYTES: usize = 254;

// ---------------------------------------------------------------------------
// Abuse throttles (security review, "critical" #1/#2)
//
// Heap-side windows, reset on upgrade - the same convention as the agent
// canister's web-channel pacing. IC HTTP calls arrive through the gateway,
// so there is no honest end-user IP to throttle on; the per-caller and
// per-reference windows below are what the protocol actually offers.
// ---------------------------------------------------------------------------

/// New charges one calling canister may create per window.
const CHARGE_WINDOW_NS: u64 = 3_600_000_000_000;
const CHARGE_MAX_PER_WINDOW: usize = 20;
/// Hard cap on stored charges, bounding stable-memory growth from charge
/// spam (the log is merchant-private data - pruning it is a product
/// decision, not something abuse handling should do silently).
const MAX_CHARGES: usize = 10_000;
/// Paid Kora verification outcalls one reference may trigger per window
/// (every hit on /checkout/return or /webhook/kora costs one outcall
/// billed to this canister, and both endpoints are unauthenticated).
const VERIFY_WINDOW_NS: u64 = 3_600_000_000_000;
const VERIFY_MIN_GAP_NS: u64 = 60_000_000_000;
const VERIFY_MAX_PER_WINDOW: usize = 10;

type HmacSha256 = Hmac<Sha256>;

thread_local! {
    static CHARGE_ATTEMPTS: std::cell::RefCell<std::collections::HashMap<Principal, Vec<u64>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static VERIFY_ATTEMPTS: std::cell::RefCell<std::collections::HashMap<String, Vec<u64>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Records one attempt in a timestamp window and reports the window's new
/// size. Timestamps are the IC's monotonic `time()`, so `saturating_sub`
/// only ever guards the upgrade-reset corner.
fn record_attempt<K>(map: &mut std::collections::HashMap<K, Vec<u64>>, key: K, now: u64, window_ns: u64) -> usize
where
    K: std::hash::Hash + Eq,
{
    let entries = map.entry(key).or_default();
    entries.retain(|at| now.saturating_sub(*at) < window_ns);
    entries.push(now);
    entries.len()
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Kora's documented webhook authenticity check (see
/// https://developers.korapay.com/docs/webhooks): `x-korapay-signature`
/// is an HMAC-SHA256 of ONLY the `data` object of the payload, signed with
/// the merchant secret key. Fail-closed on every deviation - an unsigned
/// webhook must never reach verification, because verification itself is
/// a paid outcall and a state change.
fn webhook_signature_valid(req: &HttpRequest) -> bool {
    let Some((_, signature)) = req
        .headers
        .iter()
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("x-korapay-signature"))
    else {
        return false;
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&req.body) else {
        return false;
    };
    let Some(data) = payload.get("data") else {
        return false;
    };
    // `preserve_order` (Cargo.toml) makes this reproduce Kora's signed
    // bytes: same key order as received, compact separators.
    let Ok(signed_text) = serde_json::to_string(data) else {
        return false;
    };
    let Ok(key) = secret_key() else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(key.as_bytes()) else {
        return false;
    };
    mac.update(signed_text.as_bytes());
    let expected = hex_lower(&mac.finalize().into_bytes());
    constant_time_eq(expected.as_bytes(), signature.trim().to_ascii_lowercase().as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

canister_hub_sdk::ic::metadata::canister_metadata!(
    name = "kora-payment",
    description = "Kora hosted checkout payment provider for CanisterHub projects.",
    canister_type = "custom",
    version = "1.0.0",
);

#[derive(Clone, Debug, CandidType, Deserialize, Serialize, PartialEq, Eq)]
pub struct CreateChargeRequest {
    pub order_id: u64,
    pub inventory_canister: Principal,
    pub merchant_reference: String,
    pub amount_minor: u64,
    pub currency: String,
    pub customer_email: String,
    pub customer_name: Option<String>,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize, PartialEq, Eq)]
pub struct Charge {
    pub provider: String,
    pub reference: String,
    pub checkout_url: String,
    pub status: String,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
struct ChargeRecord {
    inventory: Principal,
    order_id: u64,
    merchant_reference: String,
    reference: String,
    amount_minor: u64,
    currency: String,
    checkout_url: String,
    created_at: u64,
    #[serde(default)]
    owner_notified: bool,
    /// Lifecycle of the charge as last verified against Kora: `Pending`
    /// until a redirect/webhook verification records the outcome. Added
    /// after the first deploy - records already in stable memory decode
    /// with the `Pending` default, which is accurate for all of them
    /// (nothing had recorded an outcome before this field existed).
    #[serde(default = "default_charge_status")]
    status: String,
    /// The provider's own transaction id, once a payment is verified.
    #[serde(default)]
    transaction_id: String,
}

fn default_charge_status() -> String {
    "Pending".to_string()
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct HttpResponse {
    status_code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    upgrade: Option<bool>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct RecordPayment {
    order_id: u64,
    merchant_reference: String,
    provider: String,
    transaction_id: String,
    amount_minor: u64,
    currency: String,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct RecordPaymentFailure {
    order_id: u64,
    provider: String,
    reference: String,
    reason: String,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
enum OrderError {
    Internal(String),
    InvalidInput(String),
    NotFound(String),
    Unauthorized(String),
    Conflict(String),
}

#[ic_cdk::init]
fn init(context: ProjectContext) {
    initialize();
    assets::certify();
    set_generated_http_url();
    canister_hub_sdk::ic::config::update_project_context::<config::Config>(&context)
        .expect("failed to apply Kora payment project context");
    ic_cdk::api::debug_print(format!(
        "kora-payment: initialized project_id={} project_canisters={}",
        context.project_id,
        context.canisters.len()
    ));
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    initialize();
    assets::certify();
    set_generated_http_url();
}

fn initialize() { state::init_config(); }

fn set_generated_http_url() {
    canister_hub_sdk::ic::config::set_readonly::<config::Config>(
        "ic_http_url",
        ConfigValue::Text(config::base_url()),
    )
    .expect("failed to publish generated Kora IC HTTP URL");
}

fn secret_key() -> Result<String, String> {
    canister_hub_sdk::ic::config::get_env_text("kora_secret_key")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Kora Secret Key is not configured".to_string())
}

/// Only the calling inventory canister may choose its payment callback
/// target. It must also be explicitly trusted or verified by the protocol as
/// a package in the same project as this payment canister.
async fn authorize_inventory_caller(caller: Principal, inventory: Principal) -> Result<(), String> {
    if caller != inventory {
        ic_cdk::api::debug_print(format!("kora-payment: caller rejected caller={caller} reason=inventory_caller_mismatch"));
        return Err("inventory_canister must be the calling canister".to_string());
    }
    let trusted = canister_hub_sdk::ic::config::get_env_vector("trusted_canisters")
        .unwrap_or_default()
        .into_iter()
        .any(|value| matches!(value, canister_hub_sdk::ic::config::ConfigVectorValue::PrincipalId(id) if id == caller));
    if trusted {
        ic_cdk::api::debug_print(format!("kora-payment: caller authorized caller={caller} source=trusted_canister_list"));
        return Ok(());
    }
    let project_id = canister_hub_sdk::ic::config::get_env_text("project_id")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "caller is not trusted and project_id is not configured".to_string())?;
    let protocol_id = canister_hub_sdk::ic::config::get_env_principal("protocol_id")
        .ok_or_else(|| "caller is not trusted and protocol_id is not configured".to_string())?;
    let response = ic_cdk::call::Call::bounded_wait(protocol_id, "verify_project_package_membership")
        .with_args(&(project_id.clone(), caller))
        .await
        .map_err(|error| format!("protocol project membership check failed: {error:?}"))?;
    let member: Result<bool, String> = response.candid()
        .map_err(|error| format!("invalid protocol project membership response: {error}"))?;
    match member {
        Ok(true) => {
            ic_cdk::api::debug_print(format!("kora-payment: caller authorized caller={caller} project_id={project_id} source=project_membership"));
            Ok(())
        }
        Ok(false) => {
            ic_cdk::api::debug_print(format!("kora-payment: caller rejected caller={caller} project_id={project_id} reason=not_project_package"));
            Err("calling canister is neither trusted nor a package in this project".to_string())
        }
        Err(error) => Err(format!("protocol rejected project membership check: {error}")),
    }
}

fn validate_reference(reference: &str) -> Result<(), String> {
    if reference.is_empty()
        || reference.len() > MAX_REFERENCE_BYTES
        || !reference
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.=".contains(&byte))
    {
        return Err("merchant reference contains unsupported characters or is too long".to_string());
    }
    Ok(())
}

fn currency_exponent(currency: &str) -> Result<u32, String> {
    match currency.to_ascii_uppercase().as_str() {
        "JPY" | "KRW" | "XAF" | "XOF" | "UGX" | "RWF" => Ok(0),
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => Ok(3),
        "NGN" | "USD" | "EUR" | "GBP" | "KES" | "GHS" | "ZAR" | "TZS" => Ok(2),
        _ => Err(format!("Kora amount precision is not configured for currency {currency}")),
    }
}

fn amount_major_integer(amount_minor: u64, currency: &str) -> Result<u64, String> {
    let exponent = currency_exponent(currency)?;
    let factor = 10u64.pow(exponent);
    if amount_minor % factor != 0 {
        return Err(format!("Kora Checkout Redirect accepts whole major-unit amounts for {currency}"));
    }
    Ok(amount_minor / factor)
}

fn decimal_major_to_minor(amount: &Value, currency: &str) -> Result<u64, String> {
    let amount = match amount {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return Err("Kora verification response has no valid paid amount".to_string()),
    };
    let exponent = currency_exponent(currency)? as usize;
    let (whole, fraction) = amount.split_once('.').unwrap_or((&amount, ""));
    if whole.is_empty() || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > exponent
    {
        return Err("Kora returned an invalid amount format".to_string());
    }
    let factor = 10u64.pow(exponent as u32);
    let whole = whole.parse::<u64>().map_err(|_| "Kora amount is out of range".to_string())?;
    let mut padded = fraction.to_string();
    while padded.len() < exponent { padded.push('0'); }
    let fractional = if padded.is_empty() { 0 } else { padded.parse::<u64>().map_err(|_| "Kora amount is out of range".to_string())? };
    whole.checked_mul(factor).and_then(|value| value.checked_add(fractional))
        .ok_or_else(|| "Kora amount is out of range".to_string())
}

#[ic_cdk::update]
async fn create_charge(input: CreateChargeRequest) -> Result<Charge, String> {
    let caller = ic_cdk::api::msg_caller();
    ic_cdk::api::debug_print(format!("kora-payment: create_charge caller={caller} order_id={}", input.order_id));
    if input.inventory_canister == Principal::anonymous() {
        return Err("record payment canister must be a non-anonymous canister".to_string());
    }
    authorize_inventory_caller(caller, input.inventory_canister).await?;
    validate_reference(&input.merchant_reference)?;
    if input.customer_email.trim().is_empty() || input.customer_email.len() > MAX_EMAIL_BYTES {
        return Err("a valid customer email is required for Kora checkout".to_string());
    }
    let amount = amount_major_integer(input.amount_minor, &input.currency)?;
    if let Some(existing) = state::get_charge(&input.merchant_reference) {
        if existing.inventory != input.inventory_canister || existing.order_id != input.order_id {
            return Err("merchant reference is already attached to another order".to_string());
        }
        return Ok(Charge { provider: "kora".to_string(), reference: existing.reference, checkout_url: existing.checkout_url, status: "Pending".to_string() });
    }

    // Abuse handling (#1): bound charge-creation cost and log growth per
    // calling canister before the paid Kora outcall happens.
    let now = ic_cdk::api::time();
    let attempts = CHARGE_ATTEMPTS.with(|attempts| {
        record_attempt(&mut attempts.borrow_mut(), caller, now, CHARGE_WINDOW_NS)
    });
    if attempts > CHARGE_MAX_PER_WINDOW {
        return Err("too many charges created recently; try again later".to_string());
    }
    if state::charge_count() >= MAX_CHARGES {
        return Err("transaction log is full; contact support before creating more charges".to_string());
    }

    let base = config::base_url();
    let body = json!({
        "amount": amount,
        "currency": input.currency.to_ascii_uppercase(),
        "reference": input.merchant_reference,
        "redirect_url": format!("{base}/checkout/return"),
        "notification_url": format!("{base}/webhook/kora"),
        "narration": format!("Order #{}", input.order_id),
        "customer": { "email": input.customer_email.trim(), "name": input.customer_name.unwrap_or_default() }
    });
    let response = kora_http("POST", &format!("{KORA_API}/charges/initialize"), Some(body), &secret_key()?).await?;
    if !(200..300).contains(&response.0) {
        return Err(format!("Kora initialize charge returned HTTP {}", response.0));
    }
    let payload: Value = serde_json::from_slice(&response.1).map_err(|error| format!("invalid Kora initialize response: {error}"))?;
    if payload.get("status").and_then(Value::as_bool) != Some(true) {
        return Err(payload.get("message").and_then(Value::as_str).unwrap_or("Kora rejected the charge").to_string());
    }
    let data = payload.get("data").ok_or("Kora initialize response omitted data")?;
    let reference = data.get("reference").and_then(Value::as_str).ok_or("Kora initialize response omitted reference")?.to_string();
    let checkout_url = data.get("checkout_url").and_then(Value::as_str).ok_or("Kora initialize response omitted checkout_url")?.to_string();
    if reference != input.merchant_reference {
        return Err("Kora response reference did not match the order reference".to_string());
    }
    if !checkout_url.starts_with("https://checkout.korapay.com/") {
        return Err("Kora returned an unexpected checkout URL".to_string());
    }
    state::save_charge(ChargeRecord {
        inventory: input.inventory_canister,
        order_id: input.order_id,
        merchant_reference: input.merchant_reference.clone(),
        reference: reference.clone(),
        amount_minor: input.amount_minor,
        currency: input.currency.to_ascii_uppercase(),
        checkout_url: checkout_url.clone(),
        created_at: ic_cdk::api::time(),
        owner_notified: false,
        status: default_charge_status(),
        transaction_id: String::new(),
    });
    ic_cdk::api::debug_print(format!("kora-payment: charge initialized order_id={} reference={reference}", input.order_id));
    Ok(Charge { provider: "kora".to_string(), reference, checkout_url, status: "Pending".to_string() })
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct RecordPaymentFailureResult { order_id: u64 }

#[derive(Clone, Debug, CandidType, Deserialize)]
struct RecordPaymentResult { id: u64 }

async fn kora_http(method: &str, url: &str, body: Option<Value>, key: &str) -> Result<(u16, Vec<u8>), String> {
    let (http_method, bytes) = if method == "POST" { (HttpMethod::POST, body.map(|value| value.to_string().into_bytes())) } else { (HttpMethod::GET, None) };
    let args = HttpRequestArgs {
        url: url.to_string(),
        method: http_method,
        headers: vec![
            HttpHeader { name: "Authorization".to_string(), value: format!("Bearer {key}") },
            HttpHeader { name: "Content-Type".to_string(), value: "application/json".to_string() },
        ],
        body: bytes,
        max_response_bytes: Some(MAX_HTTP_RESPONSE),
        transform: None,
        is_replicated: Some(false),
    };
    let response = management_http_request(&args).await.map_err(|error| format!("Kora HTTPS outcall failed: {error}"))?;
    Ok((response.status.0.try_into().unwrap_or(u16::MAX), response.body))
}

fn request_reference(req: &HttpRequest) -> Option<String> {
    let query = req.url.split_once('?')?.1;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "reference")
        .map(|(_, value)| value.into_owned())
}

#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let path = req.url.split('?').next().unwrap_or(&req.url);
    match (req.method.as_str(), path) {
        ("GET", "/checkout/return") => HttpResponse { status_code: 200, headers: vec![], body: vec![], upgrade: Some(true) },
        ("POST", "/webhook/kora") => HttpResponse { status_code: 200, headers: vec![], body: vec![], upgrade: Some(true) },
        ("GET", "/") => html_response(200, "Kora payment service"),
        ("GET" | "HEAD", _) => assets::serve(&req),
        _ => html_response(404, "Not found"),
    }
}

/// Security review #2: bounds the paid Kora verification outcalls one
/// reference can trigger. `true` means this call may proceed to
/// verification; a `false` answer is an "already being handled" state,
/// not a failure - the in-window attempts belong to the same charge, so
/// acknowledging them is safe for webhooks (Kora redelivers until ACK)
/// and honest for browser redirects.
fn verify_allowed(reference: &str) -> bool {
    let now = ic_cdk::api::time();
    VERIFY_ATTEMPTS.with(|attempts| {
        let mut map = attempts.borrow_mut();
        let entries = map.entry(reference.to_string()).or_default();
        entries.retain(|at| now.saturating_sub(*at) < VERIFY_WINDOW_NS);
        if entries.len() >= VERIFY_MAX_PER_WINDOW {
            return false;
        }
        if let Some(last) = entries.last() {
            if now.saturating_sub(*last) < VERIFY_MIN_GAP_NS {
                return false;
            }
        }
        entries.push(now);
        true
    })
}

#[ic_cdk::update]
async fn http_request_update(req: HttpRequest) -> HttpResponse {
    let path = req.url.split('?').next().unwrap_or(&req.url);
    let is_redirect = req.method == "GET" && path == "/checkout/return";
    let is_webhook = req.method == "POST" && path == "/webhook/kora";
    if !is_redirect && !is_webhook { return html_response(404, "Not found"); }
    // Security review #5: a webhook without a valid Kora signature is
    // rejected before it can trigger the paid verification outcall.
    if is_webhook && !webhook_signature_valid(&req) {
        ic_cdk::api::debug_print("kora-payment: rejected webhook with missing or invalid signature".to_string());
        return html_response(401, "Invalid webhook signature");
    }
    let reference = if is_redirect { request_reference(&req) } else {
        serde_json::from_slice::<Value>(&req.body).ok()
            .and_then(|value| value.get("data")?.get("reference")?.as_str().map(str::to_string))
    };
    let Some(reference) = reference else { return html_response(400, "Payment reference is missing"); };
    if !verify_allowed(&reference) {
        return if is_webhook {
            // Already verified (or being verified) in this window - ACK so
            // Kora doesn't redeliver, without paying for another outcall.
            html_response(200, "Already received")
        } else {
            html_response(202, "Payment is still processing. Your order will update when Kora confirms it.")
        };
    }
    match verify_and_record(&reference).await {
        Ok(PaymentOutcome::Paid) => html_response(200, "Payment confirmed. You may return to your conversation."),
        Ok(PaymentOutcome::Pending) => html_response(202, "Payment is still processing. Your order will update when Kora confirms it."),
        Ok(PaymentOutcome::Failed) => html_response(200, "Payment was not completed. Please contact the vendor to arrange another attempt."),
        Err(error) => {
            ic_cdk::api::debug_print(format!("kora-payment: verification failed reference={reference} error={error}"));
            if is_webhook { html_response(500, "Unable to verify payment") } else { html_response(502, "We could not verify this payment yet. Please return to the shop and check your order status.") }
        }
    }
}

enum PaymentOutcome { Paid, Pending, Failed }

async fn verify_and_record(reference: &str) -> Result<PaymentOutcome, String> {
    validate_reference(reference)?;
    let charge = state::get_charge(reference).ok_or_else(|| "charge reference is not known to this payment module".to_string())?;
    let body = kora_http("GET", &format!("{KORA_API}/charges/{reference}"), None, &secret_key()?).await?;
    if !(200..300).contains(&body.0) { return Err(format!("Kora verification returned HTTP {}", body.0)); }
    let payload: Value = serde_json::from_slice(&body.1).map_err(|error| format!("invalid Kora verify response: {error}"))?;
    if payload.get("status").and_then(Value::as_bool) != Some(true) { return Err("Kora verification did not confirm a charge".to_string()); }
    let data = payload.get("data").ok_or("Kora verify response omitted data")?;
    if data.get("reference").and_then(Value::as_str) != Some(charge.reference.as_str()) { return Err("verified Kora reference did not match stored charge".to_string()); }
    let status = data.get("status").and_then(Value::as_str).unwrap_or_default();
    if status == "processing" || status == "pending" { return Ok(PaymentOutcome::Pending); }
    if status != "success" { return record_failure(&charge, status).await; }
    let currency = data.get("currency").and_then(Value::as_str).unwrap_or_default().to_ascii_uppercase();
    if currency != charge.currency { return Err("verified Kora currency did not match the order".to_string()); }
    let amount_value = data.get("amount_paid").or_else(|| data.get("amount")).ok_or("Kora verify response omitted amount_paid")?;
    let amount_minor = decimal_major_to_minor(amount_value, &charge.currency)?;
    if amount_minor != charge.amount_minor { return Err("verified Kora amount did not exactly match the order".to_string()); }
    let transaction_id = data.get("transaction_reference").or_else(|| data.get("payment_reference")).and_then(Value::as_str).unwrap_or(&charge.reference).to_string();
    let response = ic_cdk::call::Call::bounded_wait(charge.inventory, "record_payment")
        .with_args(&(RecordPayment {
            order_id: charge.order_id,
            merchant_reference: charge.merchant_reference.clone(),
            provider: "kora".to_string(),
            transaction_id: transaction_id.clone(),
            amount_minor,
            currency,
        },))
        .await
        .map_err(|error| format!("inventory record_payment call failed: {error:?}"))?;
    let result: Result<RecordPaymentResult, OrderError> = response.candid().map_err(|error| format!("invalid inventory payment response: {error}"))?;
    result.map_err(|error| format!("inventory rejected verified Kora payment: {error:?}"))?;
    state::update_charge(reference, |charge| {
        charge.status = "Paid".to_string();
        charge.transaction_id = transaction_id.clone();
    });
    if !charge.owner_notified && notify_owner_payment_received(&charge).await {
        state::mark_owner_notified(reference);
    }
    ic_cdk::api::debug_print(format!("kora-payment: verified and recorded order_id={} reference={reference}", charge.order_id));
    Ok(PaymentOutcome::Paid)
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct ProjectNotification {
    title: String,
    body: String,
    url: String,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct PushDelivery {
    status: Option<u16>,
    endpoint: String,
    error: Option<String>,
    subscription_removed: bool,
}

async fn notify_owner_payment_received(charge: &ChargeRecord) -> bool {
    let Some(project_id) = canister_hub_sdk::ic::config::get_env_text("project_id")
        .filter(|id| !id.trim().is_empty()) else {
        ic_cdk::api::debug_print("kora-payment: owner push skipped; project_id is not configured".to_string());
        return false;
    };
    let Some(protocol_id) = canister_hub_sdk::ic::config::get_env_principal("protocol_id") else {
        ic_cdk::api::debug_print("kora-payment: owner push skipped; protocol_id is not configured".to_string());
        return false;
    };
    let notification = ProjectNotification {
        title: "Payment received".to_string(),
        body: format!("Payment confirmed for order #{}", charge.order_id),
        url: "/admin/".to_string(),
    };
    let response = match ic_cdk::call::Call::bounded_wait(protocol_id, "send_project_notification")
        .with_args(&(project_id, notification))
        .await
    {
        Ok(response) => response,
        Err(error) => {
            ic_cdk::api::debug_print(format!("kora-payment: protocol payment notification call failed: {error:?}"));
            return false;
        }
    };
    let result: Result<Vec<PushDelivery>, String> = match response.candid() {
        Ok(result) => result,
        Err(error) => {
            ic_cdk::api::debug_print(format!("kora-payment: invalid protocol notification response: {error}"));
            return false;
        }
    };
    match result {
        Ok(deliveries) => {
            ic_cdk::api::debug_print(format!("kora-payment: owner push requested order_id={} deliveries={}", charge.order_id, deliveries.len()));
            true
        }
        Err(error) => {
            ic_cdk::api::debug_print(format!("kora-payment: protocol refused payment notification: {error}"));
            false
        }
    }
}

async fn record_failure(charge: &ChargeRecord, status: &str) -> Result<PaymentOutcome, String> {
    let response = ic_cdk::call::Call::bounded_wait(charge.inventory, "record_payment_failure")
        .with_args(&(RecordPaymentFailure {
            order_id: charge.order_id,
            provider: "kora".to_string(),
            reference: charge.merchant_reference.clone(),
            reason: format!("Kora transaction status: {status}"),
        },))
        .await
        .map_err(|error| format!("inventory record_payment_failure call failed: {error:?}"))?;
    let result: Result<RecordPaymentFailureResult, OrderError> = response.candid().map_err(|error| format!("invalid inventory payment-failure response: {error}"))?;
    result.map_err(|error| format!("inventory rejected Kora payment failure: {error:?}"))?;
    state::update_charge(&charge.reference, |record| {
        record.status = "Failed".to_string();
    });
    Ok(PaymentOutcome::Failed)
}

/// One row of the transaction log the embedded `payment-ui` shows - a
/// stored charge plus the verification outcome. Deliberately a separate
/// Candid view from `ChargeRecord`: the stored shape is internal, this one
/// is the stable UI contract.
#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
pub struct Transaction {
    pub reference: String,
    pub merchant_reference: String,
    pub order_id: u64,
    pub amount_minor: u64,
    pub currency: String,
    pub checkout_url: String,
    pub status: String,
    pub transaction_id: String,
    pub created_at: u64,
    pub owner_notified: bool,
}

/// The full transaction log, newest first. Controller-only: amounts and
/// customer references are merchant-private, unlike `create_charge` (which
/// any of the merchant's own canisters may call).
#[ic_cdk::query]
fn list_transactions() -> Result<Vec<Transaction>, String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err("only controllers can read the transaction log".to_string());
    }
    let mut transactions: Vec<Transaction> = state::list_charges()
        .into_iter()
        .map(|charge| Transaction {
            reference: charge.reference,
            merchant_reference: charge.merchant_reference,
            order_id: charge.order_id,
            amount_minor: charge.amount_minor,
            currency: charge.currency,
            checkout_url: charge.checkout_url,
            status: charge.status,
            transaction_id: charge.transaction_id,
            created_at: charge.created_at,
            owner_notified: charge.owner_notified,
        })
        .collect();
    transactions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(transactions)
}

fn html_response(status_code: u16, message: &str) -> HttpResponse {
    let body = format!("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Payment status</title><style>body{{font:16px system-ui;background:#0a0e1a;color:#e2e8f0;display:grid;min-height:100vh;place-items:center;margin:0}}main{{max-width:34rem;padding:2rem;border:1px solid #1e2d47;border-radius:1rem;background:#0f1629}}p{{color:#9aa8bd;line-height:1.5}}</style></head><body><main><h1>{}</h1><p>{}</p></main></body></html>", if status_code < 400 { "Payment status" } else { "Payment check" }, message);
    HttpResponse { status_code, headers: vec![("Content-Type".to_string(), "text/html; charset=utf-8".to_string())], body: body.into_bytes(), upgrade: None }
}

ic_cdk::export_candid!();

#[cfg(test)]
mod did_tests {
    /// Regenerates the checked-in `kora-payment.did` from the crate's real
    /// candid surface. `ic-cdk` 0.20's `export_candid!()` only emits the
    /// wasm-side `get_candid_pointer` entry point, not a callable Rust
    /// function - but it does expand `candid::export_service!()` at this
    /// crate's root, so the private `__export_service` it generates is
    /// reachable from this inline (cfg-test) module. Run with
    /// `cargo test -p kora-payment export_did` after changing any endpoint.
    #[test]
    fn export_did() {
        let did = super::__export_service();
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/kora-payment.did"),
            did,
        )
        .expect("write kora-payment.did");
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn webhook_signed_text_preserves_received_key_order() {
        // Kora signs the JSON-serialized `data` object as received, so the
        // HMAC input must re-serialize byte-for-byte. The `preserve_order`
        // serde_json feature (see Cargo.toml) is what makes this hold; if
        // it is ever dropped, this test fails and every legitimate webhook
        // signature would be rejected in production.
        let body = r#"{"status":true,"data":{"reference":"ref-1","amount":"4500.00","currency":"NGN","meta":{"b":2,"a":1}}}"#;
        let payload: Value = serde_json::from_slice(body.as_bytes()).unwrap();
        assert_eq!(
            serde_json::to_string(payload.get("data").unwrap()).unwrap(),
            r#"{"reference":"ref-1","amount":"4500.00","currency":"NGN","meta":{"b":2,"a":1}}"#
        );
    }

    #[test]
    fn hex_lower_encodes_bytes() {
        assert_eq!(hex_lower(&[0x00, 0xde, 0xad, 0xff]), "00deadff");
    }

    #[test]
    fn constant_time_eq_rejects_length_and_content_differences() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
