mod assets;
mod config;
mod http;
mod payment;
mod protocol;
mod state;
mod types;

pub use types::*;

use candid::{CandidType, Principal};
use serde::{de::DeserializeOwned, Deserialize};

const MAX_JSON_BYTES: usize = 64 * 1024;
const MAX_NAME_BYTES: usize = 200;
const MAX_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_IMAGE_URL_BYTES: usize = 2 * 1024;
const MAX_ITEMS: usize = 50;
const MAX_SESSION_BYTES: usize = 512;
const MAX_OPEN_CUSTOMER_ORDERS: usize = 5;

canister_hub_sdk::ic::metadata::canister_metadata!(
    name = "restaurant",
    description =
        "Restaurant menus, portion and plate pricing, kitchen orders, and prepaid checkout.",
    canister_type = "custom",
    version = "1.0.0",
);

fn controller_only() -> Result<(), String> {
    if ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        Ok(())
    } else {
        Err("controller access required".to_string())
    }
}

fn parse<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    if value.len() > MAX_JSON_BYTES {
        return Err(format!("parameters exceed {MAX_JSON_BYTES} bytes"));
    }
    serde_json::from_str(value).map_err(|error| format!("invalid JSON parameters: {error}"))
}

fn json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("could not encode response: {error}"))
}

fn validate_text(value: &str, label: &str, max: usize, required: bool) -> Result<(), String> {
    if required && value.trim().is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.len() > max {
        return Err(format!("{label} exceeds {max} bytes"));
    }
    Ok(())
}

fn validate_currency(currency: &str) -> Result<(), String> {
    validate_text(currency, "currency", 12, true)?;
    if !currency.bytes().all(|ch| ch.is_ascii_alphanumeric()) {
        return Err("currency must contain ASCII letters or digits".to_string());
    }
    Ok(())
}

fn customer(context: &AiContext) -> CustomerIdentity {
    CustomerIdentity::from(context)
}

async fn authenticate_agent(context: &AiContext) -> Result<CustomerIdentity, String> {
    let caller = ic_cdk::api::msg_caller();
    ic_cdk::api::debug_print(format!(
        "restaurant: AI authorization started caller={caller} project_id={}",
        context.project_id
    ));
    if caller == Principal::anonymous() || caller != context.agent_canister_id {
        return Err(
            "AiContext.agent_canister_id must match the authenticated canister caller".to_string(),
        );
    }
    validate_text(&context.session_id, "session_id", MAX_SESSION_BYTES, true)?;
    let project_id = canister_hub_sdk::ic::config::get_env_text("project_id").unwrap_or_default();
    if context.project_id.trim().is_empty() || context.project_id != project_id {
        return Err(
            "project_id does not match this restaurant package's configured project".to_string(),
        );
    }
    let protocol =
        canister_hub_sdk::ic::config::get_env_principal("protocol_id").ok_or_else(|| {
            "protocol_id is not configured for project membership verification".to_string()
        })?;
    if !protocol::verify_project_package_membership(protocol, &context.project_id, caller).await? {
        return Err("calling agent is not a package in this project".to_string());
    }
    ic_cdk::api::debug_print(format!(
        "restaurant: AI authorization accepted caller={caller}"
    ));
    Ok(customer(context))
}

fn validate_menu_input(input: &CreateMenuItem) -> Result<(), String> {
    validate_text(&input.name, "name", MAX_NAME_BYTES, true)?;
    validate_text(
        &input.description,
        "description",
        MAX_DESCRIPTION_BYTES,
        false,
    )?;
    if let Some(url) = &input.image_url {
        validate_image_url(url)?;
    }
    validate_currency(&input.currency)
}

fn validate_image_url(url: &str) -> Result<(), String> {
    validate_text(url, "image_url", MAX_IMAGE_URL_BYTES, false)?;
    if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("image_url must be an http:// or https:// URL".to_string());
    }
    Ok(())
}

fn payment_processor_only() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if ic_cdk::api::is_controller(&caller)
        || canister_hub_sdk::ic::config::get_env_principal("payment_canister") == Some(caller)
    {
        Ok(())
    } else {
        Err("configured payment processor or controller required".to_string())
    }
}

#[ic_cdk::init]
fn init(context: canister_hub_sdk::ProjectContext) {
    init_config();
    canister_hub_sdk::ic::config::update_project_context::<config::Config>(&context)
        .expect("failed to initialize restaurant project context");
    ic_cdk::api::debug_print(format!(
        "restaurant: initialized project context project_id={} package_count={}",
        context.project_id,
        context.canisters.len()
    ));
    assets::certify();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_config();
    assets::certify();
}

fn init_config() {
    canister_hub_sdk::ic::config::init_stable_store::<config::Config>(
        state::dynamic_config_memory(),
    );
}

#[ic_cdk::query]
fn list_menu() -> Vec<MenuItem> {
    state::list_menu(true)
}

#[ic_cdk::query]
fn list_all_menu() -> Result<Vec<MenuItem>, String> {
    controller_only()?;
    Ok(state::list_menu(false))
}

#[ic_cdk::query]
fn list_orders(status: Option<RestaurantOrderStatus>) -> Result<Vec<RestaurantOrder>, String> {
    controller_only()?;
    Ok(state::list_orders(status))
}

#[ic_cdk::query]
fn get_order(order_id: u64) -> Result<RestaurantOrder, String> {
    controller_only()?;
    state::get_order(order_id).ok_or_else(|| "order not found".to_string())
}

fn validate_menu_update(update: &UpdateMenuItem) -> Result<(), String> {
    if let Some(name) = &update.name {
        validate_text(name, "name", MAX_NAME_BYTES, true)?;
    }
    if let Some(description) = &update.description {
        validate_text(description, "description", MAX_DESCRIPTION_BYTES, false)?;
    }
    if let Some(currency) = &update.currency {
        validate_currency(currency)?;
    }
    if let Some(url) = &update.image_url {
        validate_image_url(url)?;
    }
    Ok(())
}

/// Controller-facing menu management for the embedded `restaurant-ui` admin.
#[ic_cdk::update]
fn create_menu_item(input: CreateMenuItem) -> Result<MenuItem, String> {
    controller_only()?;
    validate_menu_input(&input)?;
    state::create_menu(input, ic_cdk::api::time())
}

/// Controller-facing menu update for the embedded restaurant manager.
#[ic_cdk::update]
fn update_menu_item(id: u64, update: UpdateMenuItem) -> Result<MenuItem, String> {
    controller_only()?;
    validate_menu_update(&update)?;
    state::update_menu(id, update, ic_cdk::api::time())
}

#[ic_cdk::update]
async fn ai_list_menu(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("restaurant: ai_list_menu invoked".to_string());
    authenticate_agent(&context).await?;
    let _: EmptyParameters = parse(&parameters)?;
    json(&state::list_menu(true))
}

/// Shared order creation for agent chat and the public web storefront. Pricing,
/// plate charges, currency, and payment terms are always read from menu state.
async fn place_order_inner(
    customer: CustomerIdentity,
    agent_canister_id: Principal,
    input: PlaceRestaurantOrder,
) -> Result<RestaurantOrder, String> {
    let open_orders = state::list_customer_orders(&customer)
        .iter()
        .filter(|order| {
            matches!(
                order.status,
                RestaurantOrderStatus::Pending
                    | RestaurantOrderStatus::AwaitingPayment
                    | RestaurantOrderStatus::Preparing
            )
        })
        .count();
    if open_orders >= MAX_OPEN_CUSTOMER_ORDERS {
        return Err(format!(
            "you already have {open_orders} restaurant orders in progress"
        ));
    }
    if input.items.is_empty() || input.items.len() > MAX_ITEMS {
        return Err(format!("an order must contain 1..={MAX_ITEMS} menu items"));
    }
    if let Some(name) = &input.customer_name {
        validate_text(name, "customer_name", MAX_NAME_BYTES, true)?;
    }
    if let Some(email) = &input.customer_email {
        validate_text(email, "customer_email", 320, true)?;
    }
    if let Some(note) = &input.note {
        validate_text(note, "note", 4 * 1024, false)?;
    }
    if input.fulfillment == FulfillmentMethod::Delivery {
        validate_text(
            input.delivery_address.as_deref().unwrap_or_default(),
            "delivery_address",
            2048,
            true,
        )?;
    }
    if input.fulfillment == FulfillmentMethod::DineIn {
        validate_text(
            input.table_label.as_deref().unwrap_or_default(),
            "table_label",
            64,
            true,
        )?;
    }

    let mut lines = Vec::with_capacity(input.items.len());
    let mut total = 0u64;
    let mut currency: Option<String> = None;
    let mut payment_method: Option<PaymentMethod> = None;
    for request in input.items {
        if request.portions == 0 {
            return Err("portions must be greater than zero".to_string());
        }
        let item = state::get_menu(request.menu_item_id)
            .filter(|item| item.available)
            .ok_or_else(|| format!("menu item {} is unavailable", request.menu_item_id))?;
        if currency
            .as_deref()
            .is_some_and(|value| value != item.currency)
        {
            return Err("all items in an order must use the same currency".to_string());
        }
        if payment_method.is_some_and(|value| value != item.payment_method) {
            return Err("all items in an order must use the same payment method".to_string());
        }
        currency = Some(item.currency.clone());
        payment_method = Some(item.payment_method);
        let portions_total = item
            .price_per_portion_minor
            .checked_mul(request.portions)
            .ok_or("order total overflow")?;
        let plate_total = item.plate_price_minor;
        let line_total = portions_total
            .checked_add(plate_total)
            .ok_or("line total overflow")?;
        total = total
            .checked_add(line_total)
            .ok_or("order total overflow")?;
        lines.push(RestaurantOrderLine {
            menu_item_id: item.id,
            name: item.name,
            portions: request.portions,
            price_per_portion_minor: item.price_per_portion_minor,
            // The restaurant automatically charges one plastic plate per
            // ordered menu line; customers choose portions, never packaging.
            plates: 1,
            plate_price_minor: item.plate_price_minor,
            line_total_minor: line_total,
        });
    }
    let payment_method = payment_method.expect("validated non-empty items");
    let payment_status = if payment_method == PaymentMethod::Prepaid {
        RestaurantPaymentStatus::AwaitingPayment
    } else {
        RestaurantPaymentStatus::CashOnDeliveryPending
    };
    if payment_method == PaymentMethod::Prepaid {
        validate_text(
            input.customer_email.as_deref().unwrap_or_default(),
            "customer_email",
            320,
            true,
        )?;
        if canister_hub_sdk::ic::config::get_env_principal("payment_canister").is_none() {
            return Err("configure a payment processor before placing prepaid orders".to_string());
        }
    }
    let now = ic_cdk::api::time();
    let order = state::create_order(RestaurantOrder {
        id: 0,
        customer,
        agent_canister_id,
        customer_name: input.customer_name,
        customer_phone: input.customer_phone,
        customer_email: input.customer_email,
        items: lines,
        total_minor: total,
        currency: currency.unwrap_or_else(|| "USD".to_string()),
        fulfillment: input.fulfillment,
        delivery_address: input.delivery_address,
        table_label: input.table_label,
        note: input.note,
        status: if payment_method == PaymentMethod::Prepaid {
            RestaurantOrderStatus::AwaitingPayment
        } else {
            RestaurantOrderStatus::Pending
        },
        payment_method,
        payment_status,
        merchant_reference: String::new(),
        checkout_url: None,
        created_at: now,
        updated_at: now,
    })?;
    let reference = format!("restaurant-{}-{}", ic_cdk::api::canister_self(), order.id);
    let mut order = order;
    order.merchant_reference = reference.clone();
    state::update_order(order.clone());

    if payment_method == PaymentMethod::Prepaid {
        let processor = canister_hub_sdk::ic::config::get_env_principal("payment_canister")
            .expect("validated payment processor");
        match payment::create_charge(
            processor,
            payment::CreateChargeRequest {
                order_id: order.id,
                inventory_canister: ic_cdk::api::canister_self(),
                merchant_reference: reference,
                amount_minor: order.total_minor,
                currency: order.currency.clone(),
                customer_email: order.customer_email.clone().unwrap_or_default(),
                customer_name: order.customer_name.clone(),
            },
        )
        .await
        {
            Ok(charge) => {
                order.checkout_url = Some(charge.checkout_url);
                state::update_order(order.clone());
            }
            Err(error) => {
                order.status = RestaurantOrderStatus::Cancelled;
                order.payment_status = RestaurantPaymentStatus::Failed;
                order.updated_at = ic_cdk::api::time();
                state::update_order(order);
                return Err(format!("payment checkout could not be created: {error}"));
            }
        }
    }
    if let (Some(project_id), Some(protocol)) = (
        canister_hub_sdk::ic::config::get_env_text("project_id"),
        canister_hub_sdk::ic::config::get_env_principal("protocol_id"),
    ) {
        protocol::notify_owner(project_id, protocol, order.id);
    }
    Ok(order)
}

/// Guest checkout for the public storefront. The client-generated session id
/// is a bearer token used only to fetch this web customer's order status.
#[ic_cdk::update]
async fn web_place_order(
    session_id: String,
    input: PlaceRestaurantOrder,
) -> Result<RestaurantOrder, String> {
    ic_cdk::api::debug_print("restaurant: public web order request received".to_string());
    validate_text(&session_id, "session_id", MAX_SESSION_BYTES, true)?;
    let customer = CustomerIdentity { channel: AiChannel::Web, session_id };
    place_order_inner(customer, Principal::anonymous(), input).await
}

/// Public storefront polling endpoint. A web order is returned only when its
/// per-browser session token matches; agent-channel orders remain private.
#[ic_cdk::query]
fn web_get_order(session_id: String, order_id: u64) -> Option<RestaurantOrder> {
    state::get_order(order_id).filter(|order| {
        order.customer.channel == AiChannel::Web && order.customer.session_id == session_id
    })
}

#[ic_cdk::update]
async fn ai_place_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("restaurant: ai_place_order invoked".to_string());
    let customer = authenticate_agent(&context).await?;
    let input: PlaceRestaurantOrder = parse(&parameters)?;
    let order = place_order_inner(customer, context.agent_canister_id, input).await?;
    json(&order)
}

#[ic_cdk::update]
async fn ai_list_my_orders(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("restaurant: ai_list_my_orders invoked".to_string());
    let identity = authenticate_agent(&context).await?;
    let _: EmptyParameters = parse(&parameters)?;
    json(&state::list_customer_orders(&identity))
}

#[derive(Deserialize)]
struct OrderIdParameters {
    order_id: u64,
}

#[ic_cdk::update]
async fn ai_get_my_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("restaurant: ai_get_my_order invoked".to_string());
    let identity = authenticate_agent(&context).await?;
    let input: OrderIdParameters = parse(&parameters)?;
    let order = state::get_order(input.order_id)
        .filter(|order| order.customer == identity)
        .ok_or_else(|| "order was not found for the current customer".to_string())?;
    json(&order)
}

#[ic_cdk::update]
async fn ai_cancel_my_order(context: AiContext, parameters: String) -> Result<String, String> {
    ic_cdk::api::debug_print("restaurant: ai_cancel_my_order invoked".to_string());
    let identity = authenticate_agent(&context).await?;
    let input: OrderIdParameters = parse(&parameters)?;
    let mut order = state::get_order(input.order_id)
        .filter(|order| order.customer == identity)
        .ok_or_else(|| "order was not found for the current customer".to_string())?;
    if order.payment_method == PaymentMethod::Prepaid
        || !matches!(
            order.status,
            RestaurantOrderStatus::Pending | RestaurantOrderStatus::AwaitingPayment
        )
    {
        return Err(
            "this order cannot be cancelled through chat; contact the restaurant".to_string(),
        );
    }
    order.status = RestaurantOrderStatus::Cancelled;
    order.updated_at = ic_cdk::api::time();
    state::update_order(order.clone());
    json(&order)
}

/// Controller-only kitchen-status transition for the embedded restaurant manager.
fn apply_order_status(
    order_id: u64,
    status: RestaurantOrderStatus,
) -> Result<RestaurantOrder, String> {
    let mut order = state::get_order(order_id).ok_or("order not found")?;
    if order.payment_status == RestaurantPaymentStatus::AwaitingPayment {
        return Err(
            "an unpaid prepaid order cannot enter kitchen preparation or be cancelled here"
                .to_string(),
        );
    }
    if !matches!(
        status,
        RestaurantOrderStatus::Pending
            | RestaurantOrderStatus::Preparing
            | RestaurantOrderStatus::Ready
            | RestaurantOrderStatus::Served
            | RestaurantOrderStatus::OutForDelivery
            | RestaurantOrderStatus::Completed
            | RestaurantOrderStatus::Cancelled
    ) {
        return Err("only a fulfillment status may be set on an order".to_string());
    }
    order.status = status;
    order.updated_at = ic_cdk::api::time();
    state::update_order(order.clone());
    Ok(order)
}

/// Controller-facing kitchen-status update.
#[ic_cdk::update]
fn update_order_status(
    order_id: u64,
    status: RestaurantOrderStatus,
) -> Result<RestaurantOrder, String> {
    controller_only()?;
    apply_order_status(order_id, status)
}

/// Record cash-on-delivery collection from the controller-only restaurant UI.
fn collect_cash(order_id: u64, receipt_reference: &str) -> Result<RestaurantOrder, String> {
    validate_text(receipt_reference, "receipt_reference", 512, true)?;
    let mut order = state::get_order(order_id).ok_or("order not found")?;
    if order.payment_method != PaymentMethod::CashOnDelivery
        || order.payment_status != RestaurantPaymentStatus::CashOnDeliveryPending
    {
        return Err("order is not awaiting cash-on-delivery collection".to_string());
    }
    order.payment_status = RestaurantPaymentStatus::CashOnDeliveryCollected;
    order.status = RestaurantOrderStatus::Completed;
    order.updated_at = ic_cdk::api::time();
    state::update_order(order.clone());
    Ok(order)
}

/// Controller-only cash collection endpoint for the embedded restaurant UI.
#[ic_cdk::update]
fn record_cash_collection(
    order_id: u64,
    receipt_reference: String,
) -> Result<RestaurantOrder, String> {
    controller_only()?;
    collect_cash(order_id, &receipt_reference)
}

#[derive(CandidType, Deserialize)]
struct RecordPaymentFailure {
    order_id: u64,
    provider: String,
    reference: String,
    reason: String,
}
#[derive(CandidType, Deserialize)]
struct RecordPaymentResult {
    id: u64,
}
#[derive(CandidType, Deserialize)]
struct RecordPaymentFailureResult {
    order_id: u64,
}
#[derive(CandidType, Deserialize)]
enum PaymentApiError {
    Internal(String),
    InvalidInput(String),
    NotFound(String),
    Unauthorized(String),
    Conflict(String),
}

#[ic_cdk::update]
async fn record_payment(input: RecordPayment) -> Result<RecordPaymentResult, PaymentApiError> {
    payment_processor_only().map_err(PaymentApiError::Unauthorized)?;
    if input.provider.trim().is_empty() || input.transaction_id.trim().is_empty() {
        return Err(PaymentApiError::InvalidInput(
            "provider and transaction_id are required".to_string(),
        ));
    }
    let mut order = state::get_order(input.order_id)
        .ok_or_else(|| PaymentApiError::NotFound("restaurant order not found".to_string()))?;
    if order.merchant_reference != input.merchant_reference
        || order.total_minor != input.amount_minor
        || order.currency != input.currency
    {
        return Err(PaymentApiError::InvalidInput(
            "verified payment did not match restaurant order amount, currency, or reference"
                .to_string(),
        ));
    }
    if order.payment_status != RestaurantPaymentStatus::Paid {
        order.payment_status = RestaurantPaymentStatus::Paid;
        order.status = RestaurantOrderStatus::Pending;
        order.updated_at = ic_cdk::api::time();
        state::update_order(order.clone());
        send_payment_receipt(&order, &input).await;
    }
    Ok(RecordPaymentResult { id: order.id })
}

#[ic_cdk::update]
fn record_payment_failure(
    input: RecordPaymentFailure,
) -> Result<RecordPaymentFailureResult, PaymentApiError> {
    payment_processor_only().map_err(PaymentApiError::Unauthorized)?;
    let mut order = state::get_order(input.order_id)
        .ok_or_else(|| PaymentApiError::NotFound("restaurant order not found".to_string()))?;
    if order.merchant_reference != input.reference {
        return Err(PaymentApiError::InvalidInput(
            "payment reference did not match restaurant order".to_string(),
        ));
    }
    if order.payment_status != RestaurantPaymentStatus::Paid {
        order.payment_status = RestaurantPaymentStatus::Failed;
        order.status = RestaurantOrderStatus::Cancelled;
        order.updated_at = ic_cdk::api::time();
        state::update_order(order.clone());
    }
    Ok(RecordPaymentFailureResult { order_id: order.id })
}

#[derive(CandidType, Deserialize)]
struct BusinessMessage {
    session_id: String,
    text: String,
    subject: Option<String>,
}

async fn send_payment_receipt(order: &RestaurantOrder, payment: &RecordPayment) {
    if order.agent_canister_id == Principal::anonymous() {
        // Public storefront customers read the updated order through
        // `web_get_order`; anonymous isn't a canister to call for send_message.
        ic_cdk::api::debug_print(format!(
            "restaurant: web customer receipt available through order polling order_id={}",
            order.id
        ));
        return;
    }
    let mut lines = order
        .items
        .iter()
        .take(20)
        .map(|line| {
            format!(
                "{} x{} portions, {} plate(s)",
                line.name, line.portions, line.plates
            )
        })
        .collect::<Vec<_>>();
    lines.push(format!(
        "Payment received: {} {}",
        payment.amount_minor, payment.currency
    ));
    let text = format!(
        "Payment confirmed for restaurant order #{}\n{}",
        order.id,
        lines.join("\n")
    );
    let message = BusinessMessage {
        session_id: order.customer.session_id.clone(),
        text,
        subject: Some(format!("Payment receipt for order #{}", order.id)),
    };
    match ic_cdk::call::Call::bounded_wait(order.agent_canister_id, "send_message")
        .with_args(&(message,))
        .await
    {
        Ok(response) => match response.candid::<Result<(), String>>() {
            Ok(Ok(())) => ic_cdk::api::debug_print(format!(
                "restaurant: customer payment receipt sent order_id={}",
                order.id
            )),
            Ok(Err(error)) => ic_cdk::api::debug_print(format!(
                "restaurant: agent refused payment receipt order_id={} error={error}",
                order.id
            )),
            Err(error) => ic_cdk::api::debug_print(format!(
                "restaurant: invalid agent receipt response order_id={} error={error}",
                order.id
            )),
        },
        Err(error) => ic_cdk::api::debug_print(format!(
            "restaurant: agent receipt call failed order_id={} error={error:?}",
            order.id
        )),
    }
}

/// Serves the embedded restaurant admin UI under `/admin/` (see
/// `assets.rs`). Data calls still go through Candid from the browser's
/// authenticated identity.
#[ic_cdk::query]
fn http_request(request: http::HttpRequest) -> http::HttpResponse {
    assets::serve(&request)
}

#[ic_cdk::query]
fn llm_context() -> String {
    include_str!("llm_context.md").to_string()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParameters {}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests {
    /// Regenerate `restaurant.did` from the exported candid. `export_candid!`
    /// emits a private `__export_service` at the crate root, reachable from
    /// this inline (cfg-test) module. Run with `cargo test -p restaurant
    /// export_did` after changing any endpoint or shared type.
    #[test]
    fn export_did() {
        let did = super::__export_service();
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/restaurant.did"),
            did,
        )
        .expect("write restaurant.did");
    }
}
