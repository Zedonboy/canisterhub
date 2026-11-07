mod assets;
mod config;
mod http;
#[cfg(target_arch = "wasm32")]
mod payment;
#[cfg(target_arch = "wasm32")]
mod protocol;
mod state;
mod types;

pub use canister_hub_sdk::{ProjectCanister, ProjectContext};
pub use types::*;

use candid::Principal;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

const MAX_JSON_BYTES: usize = 64 * 1024;
const MAX_NAME_BYTES: usize = 200;
const MAX_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_NOTE_BYTES: usize = 4 * 1024;
const MAX_SESSION_BYTES: usize = 512;
const MAX_ORDER_LINES: usize = 50;
const MAX_IMAGE_URL_BYTES: usize = 2 * 1024;
const MAX_PAYMENT_TEXT_BYTES: usize = 512;

fn controller_only() -> Result<(), OrderError> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err(OrderError::Unauthorized(
            "controller access required".to_string(),
        ))
    }
}

fn payment_processor_only() -> Result<Principal, OrderError> {
    let caller = ic_cdk::api::msg_caller();
    if ic_cdk::api::is_controller(&caller)
        || canister_hub_sdk::ic::config::get_env_principal("payment_canister") == Some(caller)
        || state::settings()
            .trusted_payment_processors
            .contains(&caller)
    {
        Ok(caller)
    } else {
        Err(OrderError::Unauthorized(
            "trusted payment processor or controller required".to_string(),
        ))
    }
}

fn controller_actor() -> String {
    format!("controller:{}", ic_cdk::api::msg_caller())
}

fn agent_actor(context: &AiContext) -> String {
    format!(
        "agent:{}:{:?}:{}",
        context.agent_canister_id, context.channel, context.session_id
    )
}

async fn authenticate_project(project_id: &str) -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    ic_cdk::api::debug_print(format!("order_inventory: AI request project authorization started caller={caller} project_id={project_id}"));
    if project_id.trim().is_empty()
        || canister_hub_sdk::ic::config::get_env_text("project_id").as_deref() != Some(project_id)
    {
        ic_cdk::api::debug_print(format!("order_inventory: project authorization rejected caller={caller} reason=project_id_mismatch"));
        return Err(
            "project_id does not match this inventory package's configured project".to_string(),
        );
    }
    #[cfg(target_arch = "wasm32")]
    let is_project_member = {
        let protocol_id = canister_hub_sdk::ic::config::get_env_principal("protocol_id")
            .ok_or_else(|| {
                "protocol_id is not configured for project membership verification".to_string()
            })?;
        protocol::verify_project_package_membership(project_id.to_string(), caller, protocol_id)
            .await?
    };
    #[cfg(not(target_arch = "wasm32"))]
    let is_project_member = state::is_project_member(caller);
    if !is_project_member {
        ic_cdk::api::debug_print(format!("order_inventory: project authorization rejected caller={caller} reason=caller_not_project_package"));
        return Err("calling canister is not a package in this project".to_string());
    }
    ic_cdk::api::debug_print(format!(
        "order_inventory: project authorization accepted caller={caller} project_id={project_id}"
    ));
    Ok(())
}

async fn authenticate_agent(context: &AiContext) -> Result<CustomerIdentity, String> {
    authenticate_project(&context.project_id).await?;
    let caller = ic_cdk::api::msg_caller();
    ic_cdk::api::debug_print(format!(
        "order_inventory: authenticating AI agent caller={caller}"
    ));
    if caller == Principal::anonymous() || caller != context.agent_canister_id {
        ic_cdk::api::debug_print(format!(
            "order_inventory: agent authentication rejected caller={caller} reason=context_agent_mismatch"
        ));
        return Err("AiContext.agent_canister_id must match the authenticated canister caller".to_string());
    }
    validate_identity(&CustomerIdentity::from(context)).map_err(error_text)?;
    ic_cdk::api::debug_print(format!(
        "order_inventory: agent authentication accepted caller={caller} via project membership"
    ));
    Ok(CustomerIdentity::from(context))
}

async fn authenticate_staff(context: &AiContext) -> Result<CustomerIdentity, String> {
    let identity = authenticate_agent(context).await?;
    if !state::settings().staff.contains(&identity) {
        ic_cdk::api::debug_print(format!(
            "order_inventory: staff authorization rejected caller={} reason=session_not_staff",
            ic_cdk::api::msg_caller()
        ));
        return Err("this conversation is not authorized as SME staff".to_string());
    }
    ic_cdk::api::debug_print(format!(
        "order_inventory: staff authorization accepted caller={}",
        ic_cdk::api::msg_caller()
    ));
    Ok(identity)
}

fn parse_json<T: DeserializeOwned>(parameters: &str) -> Result<T, String> {
    if parameters.len() > MAX_JSON_BYTES {
        return Err(format!("parameters exceed {MAX_JSON_BYTES} bytes"));
    }
    serde_json::from_str(parameters).map_err(|error| format!("invalid JSON parameters: {error}"))
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("could not encode response: {error}"))
}

fn error_text(error: OrderError) -> String {
    match error {
        OrderError::Unauthorized(message)
        | OrderError::InvalidInput(message)
        | OrderError::NotFound(message)
        | OrderError::Conflict(message)
        | OrderError::Internal(message) => message,
    }
}

fn validate_text(value: &str, label: &str, max: usize, required: bool) -> Result<(), OrderError> {
    if required && value.trim().is_empty() {
        return Err(OrderError::InvalidInput(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > max {
        return Err(OrderError::InvalidInput(format!(
            "{label} exceeds {max} bytes"
        )));
    }
    Ok(())
}

fn validate_identity(identity: &CustomerIdentity) -> Result<(), OrderError> {
    validate_text(&identity.session_id, "session_id", MAX_SESSION_BYTES, true)
}

fn validate_currency(currency: &str) -> Result<(), OrderError> {
    validate_text(currency, "currency", 12, true)?;
    if !currency.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(OrderError::InvalidInput(
            "currency must contain only ASCII letters or digits".to_string(),
        ));
    }
    Ok(())
}

fn validate_image_url(url: &str) -> Result<(), OrderError> {
    validate_text(url, "image_url", MAX_IMAGE_URL_BYTES, false)?;
    // an http(s) URL only - the UI renders this in an <img>, never a script URL
    if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(OrderError::InvalidInput(
            "image_url must be an http:// or https:// URL".to_string(),
        ));
    }
    Ok(())
}

fn validate_create_inventory(input: &CreateInventoryItem) -> Result<(), OrderError> {
    validate_text(&input.name, "name", MAX_NAME_BYTES, true)?;
    validate_text(
        &input.description,
        "description",
        MAX_DESCRIPTION_BYTES,
        false,
    )?;
    if let Some(sku) = &input.sku {
        validate_text(sku, "sku", 100, true)?;
    }
    if let Some(url) = &input.image_url {
        validate_image_url(url)?;
    }
    validate_currency(&input.currency)
}

fn validate_update_inventory(input: &UpdateInventoryItem) -> Result<(), OrderError> {
    if let Some(name) = &input.name {
        validate_text(name, "name", MAX_NAME_BYTES, true)?;
    }
    if let Some(description) = &input.description {
        validate_text(description, "description", MAX_DESCRIPTION_BYTES, false)?;
    }
    if let Some(sku) = &input.sku {
        validate_text(sku, "sku", 100, true)?;
    }
    if let Some(currency) = &input.currency {
        validate_currency(currency)?;
    }
    if let Some(url) = &input.image_url {
        validate_image_url(url)?;
    }
    Ok(())
}

fn validate_place_order(input: &PlaceOrder) -> Result<(), OrderError> {
    if input.items.is_empty() || input.items.len() > MAX_ORDER_LINES {
        return Err(OrderError::InvalidInput(format!(
            "an order must contain 1..={MAX_ORDER_LINES} items"
        )));
    }
    if input.items.iter().any(|item| item.quantity == 0) {
        return Err(OrderError::InvalidInput(
            "item quantities must be greater than zero".to_string(),
        ));
    }
    if let Some(name) = &input.customer_name {
        validate_text(name, "customer_name", MAX_NAME_BYTES, true)?;
    }
    if let Some(phone) = &input.customer_phone {
        validate_text(phone, "customer_phone", 100, true)?;
    }
    if let Some(note) = &input.note {
        validate_text(note, "note", MAX_NOTE_BYTES, false)?;
    }
    let location = &input.delivery_location;
    validate_text(&location.address, "delivery address", 2 * 1024, true)?;
    if location.latitude.is_some() != location.longitude.is_some() {
        return Err(OrderError::InvalidInput(
            "latitude and longitude must be supplied together".to_string(),
        ));
    }
    if let Some(instructions) = &location.instructions {
        validate_text(instructions, "delivery instructions", 2 * 1024, false)?;
    }
    if let Some(latitude) = location.latitude {
        if !latitude.is_finite() || !(-90.0..=90.0).contains(&latitude) {
            return Err(OrderError::InvalidInput(
                "latitude must be between -90 and 90".to_string(),
            ));
        }
    }
    if let Some(longitude) = location.longitude {
        if !longitude.is_finite() || !(-180.0..=180.0).contains(&longitude) {
            return Err(OrderError::InvalidInput(
                "longitude must be between -180 and 180".to_string(),
            ));
        }
    }
    Ok(())
}

fn create_inventory_inner(
    input: CreateInventoryItem,
    actor: &str,
) -> Result<InventoryItem, OrderError> {
    validate_create_inventory(&input)?;
    state::create_inventory(input, actor, ic_cdk::api::time())
}

fn update_inventory_inner(
    id: u64,
    input: UpdateInventoryItem,
    actor: &str,
) -> Result<InventoryItem, OrderError> {
    validate_update_inventory(&input)?;
    state::update_inventory(id, input, actor, ic_cdk::api::time())
}

async fn place_order_inner(
    customer: CustomerIdentity,
    agent_canister_id: Option<Principal>,
    input: PlaceOrder,
    actor: &str,
) -> Result<Order, OrderError> {
    validate_place_order(&input)?;
    let needs_payment = input.items.iter()
        .filter_map(|request| state::get_inventory(request.inventory_id))
        .any(|item| item.payment_method == PaymentMethod::Prepaid);
    if needs_payment {
        if input.customer_email.as_deref().is_none_or(|email| email.trim().is_empty()) {
            return Err(OrderError::InvalidInput("customer_email is required for prepaid checkout".to_string()));
        }
        if canister_hub_sdk::ic::config::get_env_principal("payment_canister").is_none() {
            return Err(OrderError::Conflict("a payment processor package must be configured before placing prepaid orders".to_string()));
        }
    }
    let order = state::place_order(customer.clone(), agent_canister_id, input, actor, ic_cdk::api::time())?;
    let order = if order.payment_method == PaymentMethod::Prepaid {
        #[cfg(target_arch = "wasm32")]
        {
            let payment_canister = canister_hub_sdk::ic::config::get_env_principal("payment_canister")
                .ok_or_else(|| OrderError::Conflict("payment processor package is not configured".to_string()))?;
            let charge = payment::create_charge(payment_canister, payment::CreateChargeRequest {
                order_id: order.id,
                inventory_canister: ic_cdk::api::canister_self(),
                merchant_reference: order.payment_reference.clone().unwrap_or_default(),
                amount_minor: order.total_minor,
                currency: order.currency.clone(),
                customer_email: order.customer_email.clone().unwrap_or_default(),
                customer_name: order.customer_name.clone(),
            }).await;
            match charge {
                Ok(charge) => state::set_checkout_url(order.id, charge.checkout_url, ic_cdk::api::time())?,
                Err(error) => {
                    let _ = state::cancel_customer_order(order.id, &customer, "system:payment_checkout_failed", ic_cdk::api::time());
                    return Err(OrderError::Internal(format!("payment checkout could not be created: {error}")));
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = state::cancel_customer_order(order.id, &customer, "system:payment_unavailable", ic_cdk::api::time());
            return Err(OrderError::Internal("payment checkout is only available in the canister runtime".to_string()));
        }
    } else { order };
    #[cfg(target_arch = "wasm32")]
    protocol::notify_new_order(&order);
    Ok(order)
}

#[ic_cdk::init]
fn init(project_context: ProjectContext) {
    state::init_dynamic_config_store();
    config::apply_project_context(&project_context)
        .expect("failed to initialize inventory project context");
    state::set_project_members(
        project_context
            .canisters
            .iter()
            .map(|canister| canister.canister_id)
            .collect(),
    );
    ic_cdk::api::debug_print(format!(
        "order_inventory: initialized project context project_id={} package_count={}",
        project_context.project_id,
        project_context.canisters.len()
    ));
    if let Some(agent) = project_context.canister_for_package("agent.wasm") {
        state::set_trusted_agent(agent, true);
    }
    if let Some(processor) = canister_hub_sdk::ic::config::get_env_principal("payment_canister") {
        state::set_payment_processor(processor, true);
    }
    assets::certify();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    state::init_dynamic_config_store();
    assets::certify();
}

/// Serves the embedded inventory admin UI under `/admin/` and the public
/// storefront at `/` (see `assets.rs`). Data calls still go through Candid
/// from the browser's authenticated identity.
#[ic_cdk::query]
fn http_request(request: http::HttpRequest) -> http::HttpResponse {
    assets::serve(&request)
}

#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

#[ic_cdk::query]
fn get_business() -> BusinessProfile {
    state::settings().business
}

#[ic_cdk::query]
fn get_settings() -> Result<Settings, OrderError> {
    controller_only()?;
    Ok(state::settings())
}

#[ic_cdk::update]
fn set_business(profile: BusinessProfile) -> Result<BusinessProfile, OrderError> {
    controller_only()?;
    validate_text(&profile.name, "business name", MAX_NAME_BYTES, true)?;
    validate_currency(&profile.currency)?;
    state::set_business(profile.clone());
    Ok(profile)
}

#[ic_cdk::update]
fn set_trusted_agent(agent: Principal, enabled: bool) -> Result<(), OrderError> {
    controller_only()?;
    if agent == Principal::anonymous() {
        return Err(OrderError::InvalidInput(
            "agent must not be anonymous".to_string(),
        ));
    }
    state::set_trusted_agent(agent, enabled);
    Ok(())
}

#[ic_cdk::update]
fn set_staff(identity: CustomerIdentity, enabled: bool) -> Result<(), OrderError> {
    controller_only()?;
    validate_identity(&identity)?;
    state::set_staff(identity, enabled);
    Ok(())
}

#[ic_cdk::update]
fn set_payment_processor(processor: Principal, enabled: bool) -> Result<(), OrderError> {
    controller_only()?;
    if processor == Principal::anonymous() {
        return Err(OrderError::InvalidInput(
            "payment processor must not be anonymous".to_string(),
        ));
    }
    state::set_payment_processor(processor, enabled);
    Ok(())
}

#[ic_cdk::update]
fn set_prepaid_reservation_ttl_secs(seconds: u64) -> Result<(), OrderError> {
    controller_only()?;
    if !(60..=7 * 24 * 60 * 60).contains(&seconds) {
        return Err(OrderError::InvalidInput(
            "reservation TTL must be between 60 seconds and 7 days".to_string(),
        ));
    }
    state::set_reservation_ttl_ns(seconds.saturating_mul(1_000_000_000));
    Ok(())
}

#[ic_cdk::update]
fn create_inventory(input: CreateInventoryItem) -> Result<InventoryItem, OrderError> {
    controller_only()?;
    create_inventory_inner(input, &controller_actor())
}

#[ic_cdk::update]
fn update_inventory(id: u64, input: UpdateInventoryItem) -> Result<InventoryItem, OrderError> {
    controller_only()?;
    update_inventory_inner(id, input, &controller_actor())
}

#[ic_cdk::query]
fn get_inventory(id: u64) -> Option<InventoryItem> {
    state::get_inventory(id)
}

#[ic_cdk::query]
fn list_inventory() -> Vec<InventoryItem> {
    state::list_inventory(true)
}

#[ic_cdk::query]
fn list_all_inventory() -> Result<Vec<InventoryItem>, OrderError> {
    controller_only()?;
    Ok(state::list_inventory(false))
}

#[ic_cdk::query]
fn get_order(id: u64) -> Result<Order, OrderError> {
    controller_only()?;
    state::get_order(id).ok_or_else(|| OrderError::NotFound("order not found".to_string()))
}

#[ic_cdk::query]
fn get_payment(order_id: u64) -> Result<PaymentRecord, OrderError> {
    controller_only()?;
    state::get_payment(order_id)
        .ok_or_else(|| OrderError::NotFound("payment record not found".to_string()))
}

#[ic_cdk::query]
fn list_audit(
    order_id: Option<u64>,
    offset: u64,
    limit: u64,
) -> Result<Vec<AuditEntry>, OrderError> {
    controller_only()?;
    Ok(state::list_audit(order_id, offset, limit))
}

#[ic_cdk::query]
fn list_orders(status: Option<OrderStatus>) -> Result<Vec<Order>, OrderError> {
    controller_only()?;
    Ok(state::list_orders(status))
}

#[ic_cdk::update]
fn update_order_status(id: u64, status: OrderStatus) -> Result<Order, OrderError> {
    controller_only()?;
    state::update_order_status(id, status, &controller_actor(), ic_cdk::api::time())
}

fn validate_payment_text(value: &str, label: &str) -> Result<(), OrderError> {
    validate_text(value, label, MAX_PAYMENT_TEXT_BYTES, true)
}

#[cfg(target_arch = "wasm32")]
async fn deliver_payment_receipt(
    agent: Principal,
    order: &Order,
    payment: &PaymentRecord,
) -> Result<(), String> {
    protocol::send_payment_receipt(agent, order, payment).await
}

#[cfg(not(target_arch = "wasm32"))]
async fn deliver_payment_receipt(
    _agent: Principal,
    _order: &Order,
    _payment: &PaymentRecord,
) -> Result<(), String> {
    Err("payment receipt delivery is only available in the canister runtime".to_string())
}

#[ic_cdk::update]
async fn record_payment(input: RecordPayment) -> Result<Order, OrderError> {
    let processor = payment_processor_only()?;
    validate_payment_text(&input.provider, "payment provider")?;
    validate_payment_text(&input.transaction_id, "payment transaction id")?;
    validate_payment_text(&input.merchant_reference, "merchant payment reference")?;
    validate_currency(&input.currency)?;
    let was_paid = state::get_payment(input.order_id)
        .is_some_and(|payment| payment.status == PaymentStatus::Paid);
    let order = state::record_payment(
        input,
        &format!("payment_processor:{processor}"),
        ic_cdk::api::time(),
    )?;
    if !was_paid {
        if let Some(agent) = order.agent_canister_id {
            let payment = state::get_payment(order.id);
            if let Some(payment) = payment {
                if let Err(error) = deliver_payment_receipt(agent, &order, &payment).await {
                    ic_cdk::api::debug_print(format!("order_inventory: agent send_message receipt delivery failed order_id={} error={error}", order.id));
                }
            } else {
                ic_cdk::api::debug_print(format!("order_inventory: paid order has no payment receipt record order_id={}", order.id));
            }
        } else {
            ic_cdk::api::debug_print(format!("order_inventory: payment receipt has no originating agent order_id={}", order.id));
        }
    }
    Ok(order)
}

#[ic_cdk::update]
fn record_payment_failure(input: RecordPaymentFailure) -> Result<PaymentRecord, OrderError> {
    let processor = payment_processor_only()?;
    validate_payment_text(&input.provider, "payment provider")?;
    validate_payment_text(&input.reference, "payment reference")?;
    validate_payment_text(&input.reason, "payment failure reason")?;
    state::record_payment_failure(
        input,
        &format!("payment_processor:{processor}"),
        ic_cdk::api::time(),
    )
}

#[ic_cdk::update]
fn record_refund(input: RecordRefund) -> Result<Order, OrderError> {
    let processor = payment_processor_only()?;
    validate_payment_text(&input.provider, "refund provider")?;
    validate_payment_text(&input.transaction_id, "refund transaction id")?;
    state::record_refund(
        input,
        &format!("payment_processor:{processor}"),
        ic_cdk::api::time(),
    )
}

#[ic_cdk::update]
fn record_cash_collection(input: RecordCashCollection) -> Result<Order, OrderError> {
    let processor = payment_processor_only()?;
    validate_payment_text(&input.receipt_reference, "cash receipt reference")?;
    validate_currency(&input.currency)?;
    state::record_cash_collection(
        input,
        &format!("payment_processor:{processor}"),
        ic_cdk::api::time(),
    )
}

#[ic_cdk::update]
fn expire_unpaid_orders(limit: u64) -> Result<u64, OrderError> {
    controller_only()?;
    state::expire_unpaid_orders(limit, &controller_actor(), ic_cdk::api::time())
}

#[ic_cdk::update]
async fn ai_list_inventory(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_list_inventory invoked".to_string());
    authenticate_agent(&context).await?;
    let _: EmptyParameters = parse_json(&parameters)?;
    json(&state::list_inventory(true))
}

#[ic_cdk::update]
async fn ai_place_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_place_order invoked".to_string());
    let customer = authenticate_agent(&context).await?;
    let input: PlaceOrder = parse_json(&parameters)?;
    let order = place_order_inner(customer, Some(context.agent_canister_id), input, &agent_actor(&context)).await.map_err(error_text)?;
    json(&order)
}

#[ic_cdk::update]
async fn ai_list_my_orders(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_list_my_orders invoked".to_string());
    let customer = authenticate_agent(&context).await?;
    let _: EmptyParameters = parse_json(&parameters)?;
    json(&state::list_customer_orders(&customer))
}

#[ic_cdk::update]
async fn ai_get_my_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_get_my_order invoked".to_string());
    let customer = authenticate_agent(&context).await?;
    let input: OrderIdParameters = parse_json(&parameters)?;
    let order = state::get_order(input.order_id)
        .filter(|order| order.customer == customer)
        .ok_or_else(|| "order was not found for the current customer".to_string())?;
    json(&order)
}

// ---------------------------------------------------------------------------
// Public storefront (signed-in customers, no agent in between)
// ---------------------------------------------------------------------------
//
// These mirror `ai_place_order` / `ai_list_my_orders` / `ai_cancel_my_order`,
// but the customer is the authenticated caller instead of an agent-supplied
// conversation. The identity is derived here from `msg_caller` - never from an
// argument - so one customer can neither place nor read nor cancel another's
// orders. Prices are always taken from inventory by `state::place_order`.

/// Orders a single storefront customer may have waiting at once. Stock is
/// reserved on placement, so without a cap a signed-in client could lock up
/// the whole inventory by placing orders it never collects.
const MAX_OPEN_WEB_ORDERS: usize = 5;

fn web_customer() -> Result<CustomerIdentity, OrderError> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err(OrderError::Unauthorized(
            "sign in with Internet Identity to place or view orders".to_string(),
        ));
    }
    Ok(CustomerIdentity {
        channel: AiChannel::Web,
        session_id: caller.to_text(),
    })
}

fn web_actor(customer: &CustomerIdentity) -> String {
    format!("web:{}", customer.session_id)
}

#[ic_cdk::update]
async fn place_order(input: PlaceOrder) -> Result<Order, OrderError> {
    let customer = web_customer()?;
    let open = state::list_customer_orders(&customer)
        .iter()
        .filter(|order| {
            matches!(
                order.status,
                OrderStatus::Pending | OrderStatus::AwaitingPayment
            )
        })
        .count();
    if open >= MAX_OPEN_WEB_ORDERS {
        return Err(OrderError::Conflict(format!(
            "you already have {open} orders waiting - wait for them to be handled or cancel one first"
        )));
    }
    let actor = web_actor(&customer);
    place_order_inner(customer, None, input, &actor).await
}

/// The caller's own orders, newest first.
#[ic_cdk::query]
fn list_my_orders() -> Result<Vec<Order>, OrderError> {
    let customer = web_customer()?;
    let mut orders = state::list_customer_orders(&customer);
    orders.reverse();
    Ok(orders)
}

#[ic_cdk::update]
fn cancel_my_order(id: u64) -> Result<Order, OrderError> {
    let customer = web_customer()?;
    let actor = web_actor(&customer);
    state::cancel_customer_order(id, &customer, &actor, ic_cdk::api::time())
}

#[derive(Deserialize)]
struct OrderIdParameters {
    order_id: u64,
}

#[ic_cdk::update]
async fn ai_cancel_my_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_cancel_my_order invoked".to_string());
    let customer = authenticate_agent(&context).await?;
    let input: OrderIdParameters = parse_json(&parameters)?;
    let order = state::cancel_customer_order(
        input.order_id,
        &customer,
        &agent_actor(&context),
        ic_cdk::api::time(),
    )
    .map_err(error_text)?;
    json(&order)
}

#[ic_cdk::update]
async fn ai_add_inventory(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_add_inventory invoked".to_string());
    authenticate_staff(&context).await?;
    let input: CreateInventoryItem = parse_json(&parameters)?;
    let item = create_inventory_inner(input, &agent_actor(&context)).map_err(error_text)?;
    json(&item)
}

#[ic_cdk::update]
async fn ai_list_all_inventory(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_list_all_inventory invoked".to_string());
    authenticate_staff(&context).await?;
    let _: EmptyParameters = parse_json(&parameters)?;
    json(&state::list_inventory(false))
}

#[ic_cdk::update]
async fn ai_list_my_inventory(context: AiContext, parameters: String) -> Result<String, String> {
    let caller = ic_cdk::api::msg_caller();
    ic_cdk::api::debug_print(format!(
        "order_inventory: ai_list_my_inventory invoked caller={caller}"
    ));
    // This surface intentionally requires the calling agent canister itself
    // to be a controller, in addition to the normal project and staff checks.
    controller_only().map_err(error_text)?;
    authenticate_staff(&context).await?;
    let _: EmptyParameters = parse_json(&parameters)?;
    ic_cdk::api::debug_print(format!(
        "order_inventory: ai_list_my_inventory authorized controller caller={caller}"
    ));
    json(&state::list_inventory(false))
}

#[derive(Deserialize)]
struct UpdateInventoryParameters {
    id: u64,
    update: UpdateInventoryItem,
}

#[ic_cdk::update]
async fn ai_update_inventory(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_update_inventory invoked".to_string());
    authenticate_staff(&context).await?;
    let input: UpdateInventoryParameters = parse_json(&parameters)?;
    let item = update_inventory_inner(input.id, input.update, &agent_actor(&context))
        .map_err(error_text)?;
    json(&item)
}

#[derive(Deserialize)]
struct ListOrdersParameters {
    status: Option<OrderStatus>,
}

#[ic_cdk::update]
async fn ai_list_orders(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_list_orders invoked".to_string());
    authenticate_staff(&context).await?;
    let input: ListOrdersParameters = parse_json(&parameters)?;
    json(&state::list_orders(input.status))
}

#[derive(Deserialize)]
struct UpdateOrderStatusParameters {
    order_id: u64,
    status: OrderStatus,
}

#[ic_cdk::update]
async fn ai_update_order_status(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_update_order_status invoked".to_string());
    authenticate_staff(&context).await?;
    let input: UpdateOrderStatusParameters = parse_json(&parameters)?;
    let order = state::update_order_status(
        input.order_id,
        input.status,
        &agent_actor(&context),
        ic_cdk::api::time(),
    )
    .map_err(error_text)?;
    json(&order)
}

#[ic_cdk::update]
async fn ai_list_order_audit(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("order_inventory: ai_list_order_audit invoked".to_string());
    authenticate_staff(&context).await?;
    let input: OrderIdParameters = parse_json(&parameters)?;
    json(&state::list_audit(Some(input.order_id), 0, 200))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParameters {}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests {
    use super::*;

    fn order_with_location(location: DeliveryLocation) -> PlaceOrder {
        PlaceOrder {
            items: vec![OrderItemRequest {
                inventory_id: 1,
                quantity: 1,
            }],
            customer_name: None,
            customer_phone: None,
            customer_email: None,
            delivery_location: location,
            note: None,
        }
    }

    #[test]
    fn delivery_address_is_required() {
        assert!(validate_place_order(&order_with_location(DeliveryLocation {
            address: String::new(),
            latitude: None,
            longitude: None,
            instructions: None,
        }))
        .is_err());
    }

    #[test]
    fn location_accepts_address_with_optional_coordinates() {
        assert!(validate_place_order(&order_with_location(DeliveryLocation {
            address: "12 Market Road".to_string(),
            latitude: None,
            longitude: None,
            instructions: None,
        }))
        .is_ok());
        assert!(validate_place_order(&order_with_location(DeliveryLocation {
            address: "12 Market Road".to_string(),
            latitude: Some(6.5244),
            longitude: Some(3.3792),
            instructions: None,
        }))
        .is_ok());
    }

    #[test]
    fn location_rejects_empty_or_out_of_range_values() {
        assert!(validate_place_order(&order_with_location(DeliveryLocation {
            address: "12 Market Road".to_string(),
            latitude: Some(6.5),
            longitude: None,
            instructions: None,
        }))
        .is_err());
        assert!(validate_place_order(&order_with_location(DeliveryLocation {
            address: "12 Market Road".to_string(),
            latitude: Some(91.0),
            longitude: Some(3.0),
            instructions: None,
        }))
        .is_err());
    }

    /// Regenerate `order_inventory.did` from the exported candid. `export_candid!`
    /// emits a private `__export_service` at the crate root, reachable from this
    /// inline (cfg-test) module. Run with `cargo test -p order_inventory export_did`
    /// after changing any endpoint or shared type.
    #[test]
    fn export_did() {
        let did = super::__export_service();
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/order_inventory.did"),
            did,
        )
        .expect("write order_inventory.did");
    }
}
