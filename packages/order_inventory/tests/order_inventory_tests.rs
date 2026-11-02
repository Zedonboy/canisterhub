use candid::{encode_one, Principal};
use canister_hub_sdk::ic::config::{ConfigFieldSchema, ConfigType, ConfigValue};
use order_inventory::{
    AiChannel, AiContext, AuditEntry, CreateInventoryItem, CustomerIdentity, InventoryItem,
    InventoryKind, Order, OrderStatus, PaymentMethod, PaymentStatus, RecordCashCollection,
    RecordPayment, RecordPaymentFailure, RecordRefund, Settings, UpdateInventoryItem,
};
use pocket_ic::{query_candid, query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};
use std::collections::HashMap;

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/order_inventory.wasm"
));

fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn setup() -> (PocketIc, Principal, Principal) {
    let admin = principal(1);
    let agent = principal(2);
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let canister = pic.create_canister_with_settings(Some(admin), None);
    pic.add_cycles(canister, 10_000_000_000_000);
    pic.install_canister(
        canister,
        WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(admin),
    );
    let (trusted,): (Result<(), order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, admin, "set_trusted_agent", (agent, true)).unwrap();
    trusted.unwrap();
    (pic, canister, agent)
}

fn context(agent: Principal, session_id: &str) -> AiContext {
    AiContext {
        agent,
        channel: AiChannel::WhatsApp,
        session_id: session_id.to_string(),
    }
}

fn add_stock(pic: &PocketIc, canister: Principal) -> InventoryItem {
    let input = CreateInventoryItem {
        name: "Cocoa box".to_string(),
        description: "Locally made cocoa".to_string(),
        sku: Some("COCOA-1".to_string()),
        kind: InventoryKind::Product,
        price_minor: 2_500,
        currency: "NGN".to_string(),
        image_url: None,
        stock_quantity: Some(5),
    };
    let (result,): (Result<InventoryItem, order_inventory::OrderError>,) =
        update_candid_as(pic, canister, principal(1), "create_inventory", (input,)).unwrap();
    result.unwrap()
}

#[test]
fn llm_context_advertises_only_callable_ai_methods() {
    let (pic, canister, _) = setup();
    let (document,): (String,) = query_candid(&pic, canister, "llm_context", ()).unwrap();
    let document: serde_json::Value = serde_json::from_str(&document).unwrap();
    let methods = document["methods"].as_array().unwrap();
    assert_eq!(methods.len(), 10);
    assert!(methods
        .iter()
        .all(|method| method["name"].as_str().unwrap().starts_with("ai_")));
}

#[test]
fn customer_can_order_with_address_without_gps_and_stock_is_reserved() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 2 }],
        "customer_name": "Ada",
        "delivery_location": { "address": "12 Market Road, Lagos" }
    })
    .to_string();
    let (result,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "+2348000000000"), parameters),
    )
    .unwrap();
    let order: Order = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(order.total_minor, 5_000);
    assert_eq!(order.delivery_location.address, "12 Market Road, Lagos");
    assert_eq!(order.delivery_location.latitude, None);
    assert_eq!(order.payment_method, PaymentMethod::CashOnDelivery);
    assert_eq!(order.payment_status, PaymentStatus::CashOnDeliveryPending);

    let (stored,): (Option<InventoryItem>,) =
        query_candid(&pic, canister, "get_inventory", (item.id,)).unwrap();
    assert_eq!(stored.unwrap().stock_quantity, Some(3));

    let (cancelled,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_cancel_my_order",
        (
            context(agent, "+2348000000000"),
            serde_json::json!({ "order_id": order.id }).to_string(),
        ),
    )
    .unwrap();
    assert!(cancelled.is_ok());
    let (restored,): (Option<InventoryItem>,) =
        query_candid(&pic, canister, "get_inventory", (item.id,)).unwrap();
    assert_eq!(restored.unwrap().stock_quantity, Some(5));
}

#[test]
fn prepaid_order_requires_exact_processor_verified_payment_before_fulfillment() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 1 }],
        "delivery_location": { "address": "1 Payment Lane" },
        "payment_method": "Prepaid"
    })
    .to_string();
    let (placed,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "prepaid-customer"), parameters),
    )
    .unwrap();
    let order: Order = serde_json::from_str(&placed.unwrap()).unwrap();
    assert_eq!(order.status, OrderStatus::AwaitingPayment);
    assert_eq!(order.payment_status, PaymentStatus::AwaitingPayment);
    assert!(order.payment_reference.is_some());
    assert!(order.reservation_expires_at.is_some());

    let (blocked,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "update_order_status",
        (order.id, OrderStatus::Confirmed),
    )
    .unwrap();
    assert!(blocked.is_err());

    let (failed,): (Result<order_inventory::PaymentRecord, order_inventory::OrderError>,) =
        update_candid_as(
            &pic,
            canister,
            principal(1),
            "record_payment_failure",
            (RecordPaymentFailure {
                order_id: order.id,
                provider: "test-pay".to_string(),
                reference: order.payment_reference.clone().unwrap(),
                reason: "card declined".to_string(),
            },),
        )
        .unwrap();
    assert_eq!(failed.unwrap().status, PaymentStatus::Failed);

    let payment = RecordPayment {
        order_id: order.id,
        merchant_reference: order.payment_reference.clone().unwrap(),
        provider: "test-pay".to_string(),
        transaction_id: "txn-1".to_string(),
        amount_minor: order.total_minor,
        currency: order.currency.clone(),
    };
    let (untrusted,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(9),
        "record_payment",
        (payment.clone(),),
    )
    .unwrap();
    assert!(matches!(
        untrusted,
        Err(order_inventory::OrderError::Unauthorized(_))
    ));

    let mut wrong = payment.clone();
    wrong.amount_minor -= 1;
    let (wrong_amount,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, principal(1), "record_payment", (wrong,)).unwrap();
    assert!(wrong_amount.is_err());

    let (paid,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "record_payment",
        (payment.clone(),),
    )
    .unwrap();
    let paid = paid.unwrap();
    assert_eq!(paid.status, OrderStatus::Pending);
    assert_eq!(paid.payment_status, PaymentStatus::Paid);
    assert_eq!(paid.amount_paid_minor, paid.total_minor);

    // Provider retries are idempotent.
    let (replayed,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, principal(1), "record_payment", (payment,)).unwrap();
    assert_eq!(replayed.unwrap().payment_status, PaymentStatus::Paid);

    let (confirmed,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "update_order_status",
        (order.id, OrderStatus::Confirmed),
    )
    .unwrap();
    assert_eq!(confirmed.unwrap().status, OrderStatus::Confirmed);

    let (audit,): (Result<Vec<AuditEntry>, order_inventory::OrderError>,) = query_candid_as(
        &pic,
        canister,
        principal(1),
        "list_audit",
        (Some(order.id), 0u64, 100u64),
    )
    .unwrap();
    let actions: Vec<_> = audit
        .unwrap()
        .into_iter()
        .map(|entry| entry.action)
        .collect();
    assert!(actions.contains(&"order.placed".to_string()));
    assert!(actions.contains(&"payment.verified".to_string()));
    assert!(actions.contains(&"order.status_changed".to_string()));
}

#[test]
fn unpaid_prepaid_reservation_expires_and_restores_stock() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let (ttl,): (Result<(), order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "set_prepaid_reservation_ttl_secs",
        (60u64,),
    )
    .unwrap();
    ttl.unwrap();
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 3 }],
        "delivery_location": { "address": "4 Expiry Close" },
        "payment_method": "Prepaid"
    })
    .to_string();
    let (placed,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "expiry-customer"), parameters),
    )
    .unwrap();
    let order: Order = serde_json::from_str(&placed.unwrap()).unwrap();
    pic.advance_time(std::time::Duration::from_secs(61));
    let (expired,): (Result<u64, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "expire_unpaid_orders",
        (100u64,),
    )
    .unwrap();
    assert_eq!(expired.unwrap(), 1);
    let (stored,): (Result<Order, order_inventory::OrderError>,) =
        query_candid_as(&pic, canister, principal(1), "get_order", (order.id,)).unwrap();
    let stored = stored.unwrap();
    assert_eq!(stored.status, OrderStatus::Expired);
    assert_eq!(stored.payment_status, PaymentStatus::Expired);
    assert!(stored.stock_released);
    let (stock,): (Option<InventoryItem>,) =
        query_candid(&pic, canister, "get_inventory", (item.id,)).unwrap();
    assert_eq!(stock.unwrap().stock_quantity, Some(5));
}

#[test]
fn cash_on_delivery_must_be_collected_before_completion() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 1 }],
        "delivery_location": { "address": "2 Delivery Road" },
        "payment_method": "CashOnDelivery"
    })
    .to_string();
    let (placed,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "cod-customer"), parameters),
    )
    .unwrap();
    let order: Order = serde_json::from_str(&placed.unwrap()).unwrap();

    for status in [
        OrderStatus::Confirmed,
        OrderStatus::Preparing,
        OrderStatus::Ready,
        OrderStatus::OutForDelivery,
    ] {
        let (updated,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
            &pic,
            canister,
            principal(1),
            "update_order_status",
            (order.id, status),
        )
        .unwrap();
        updated.unwrap();
    }
    let (blocked,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "update_order_status",
        (order.id, OrderStatus::Completed),
    )
    .unwrap();
    assert!(blocked.is_err());

    let collection = RecordCashCollection {
        order_id: order.id,
        receipt_reference: "cash-receipt-1".to_string(),
        amount_minor: order.total_minor,
        currency: order.currency,
    };
    let (collected,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "record_cash_collection",
        (collection,),
    )
    .unwrap();
    assert_eq!(
        collected.unwrap().payment_status,
        PaymentStatus::CashOnDeliveryCollected
    );
    let (completed,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "update_order_status",
        (order.id, OrderStatus::Completed),
    )
    .unwrap();
    assert_eq!(completed.unwrap().status, OrderStatus::Completed);
}

#[test]
fn cancelling_a_paid_order_releases_stock_and_requires_a_traceable_refund() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 2 }],
        "delivery_location": { "address": "3 Refund Street" },
        "payment_method": "Prepaid"
    })
    .to_string();
    let (placed,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "refund-customer"), parameters),
    )
    .unwrap();
    let order: Order = serde_json::from_str(&placed.unwrap()).unwrap();
    let (paid,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "record_payment",
        (RecordPayment {
            order_id: order.id,
            merchant_reference: order.payment_reference.clone().unwrap(),
            provider: "test-pay".to_string(),
            transaction_id: "txn-refund-source".to_string(),
            amount_minor: order.total_minor,
            currency: order.currency.clone(),
        },),
    )
    .unwrap();
    paid.unwrap();

    let (cancelled,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_cancel_my_order",
        (
            context(agent, "refund-customer"),
            serde_json::json!({ "order_id": order.id }).to_string(),
        ),
    )
    .unwrap();
    let cancelled: Order = serde_json::from_str(&cancelled.unwrap()).unwrap();
    assert_eq!(cancelled.payment_status, PaymentStatus::RefundPending);
    let (stock,): (Option<InventoryItem>,) =
        query_candid(&pic, canister, "get_inventory", (item.id,)).unwrap();
    assert_eq!(stock.unwrap().stock_quantity, Some(5));

    let refund = RecordRefund {
        order_id: order.id,
        provider: "test-pay".to_string(),
        transaction_id: "refund-1".to_string(),
        amount_minor: order.total_minor,
    };
    let (refunded,): (Result<Order, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "record_refund",
        (refund.clone(),),
    )
    .unwrap();
    assert_eq!(refunded.unwrap().payment_status, PaymentStatus::Refunded);
    let (replayed,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, principal(1), "record_refund", (refund,)).unwrap();
    assert_eq!(replayed.unwrap().amount_refunded_minor, order.total_minor);
}

#[test]
fn customer_order_history_is_scoped_to_the_agent_session() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let parameters = serde_json::json!({
        "items": [{ "inventory_id": item.id, "quantity": 1 }],
        "delivery_location": { "address": "5 Marina Road" }
    })
    .to_string();
    let _: (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_place_order",
        (context(agent, "customer-a"), parameters),
    )
    .unwrap();

    let (result,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_list_my_orders",
        (context(agent, "customer-b"), "{}".to_string()),
    )
    .unwrap();
    let orders: Vec<Order> = serde_json::from_str(&result.unwrap()).unwrap();
    assert!(orders.is_empty());
}

#[test]
fn untrusted_callers_and_non_staff_sessions_cannot_manage_inventory() {
    let (pic, canister, agent) = setup();
    let parameters = serde_json::json!({
        "name": "Service",
        "description": "Consultation",
        "kind": "Service",
        "price_minor": 1000,
        "currency": "NGN"
    })
    .to_string();
    let (not_staff,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_add_inventory",
        (context(agent, "customer"), parameters.clone()),
    )
    .unwrap();
    assert!(not_staff.is_err());

    let stranger = principal(9);
    let (untrusted,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        stranger,
        "ai_list_inventory",
        (context(stranger, "customer"), "{}".to_string()),
    )
    .unwrap();
    assert!(untrusted.is_err());
}

#[test]
fn authorized_staff_can_manage_inventory_through_ai_methods() {
    let (pic, canister, agent) = setup();
    let staff = CustomerIdentity {
        channel: AiChannel::WhatsApp,
        session_id: "staff-number".to_string(),
    };
    let (granted,): (Result<(), order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        principal(1),
        "set_staff",
        (staff.clone(), true),
    )
    .unwrap();
    granted.unwrap();

    let (created,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_add_inventory",
        (
            context(agent, &staff.session_id),
            serde_json::json!({
                "name": "Consultation",
                "description": "One-hour service",
                "kind": "Service",
                "price_minor": 15000,
                "currency": "NGN"
            })
            .to_string(),
        ),
    )
    .unwrap();
    let item: InventoryItem = serde_json::from_str(&created.unwrap()).unwrap();

    let (updated,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_update_inventory",
        (
            context(agent, &staff.session_id),
            serde_json::json!({ "id": item.id, "update": { "active": false } }).to_string(),
        ),
    )
    .unwrap();
    assert!(
        !serde_json::from_str::<InventoryItem>(&updated.unwrap())
            .unwrap()
            .active
    );

    let (public_items,): (Vec<InventoryItem>,) =
        query_candid(&pic, canister, "list_inventory", ()).unwrap();
    assert!(public_items.is_empty());
    let (all,): (Result<String, String>,) = update_candid_as(
        &pic,
        canister,
        agent,
        "ai_list_all_inventory",
        (context(agent, &staff.session_id), "{}".to_string()),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<InventoryItem>>(&all.unwrap())
            .unwrap()
            .len(),
        1
    );

    let (audit,): (Result<Vec<AuditEntry>, order_inventory::OrderError>,) = query_candid_as(
        &pic,
        canister,
        principal(1),
        "list_audit",
        (None::<u64>, 0u64, 100u64),
    )
    .unwrap();
    let audit = audit.unwrap();
    assert!(audit.iter().any(|entry| {
        entry.action == "inventory.created"
            && entry.actor.contains(&staff.session_id)
            && entry.details.contains(&format!("inventory_id={}", item.id))
    }));
    assert!(audit.iter().any(|entry| {
        entry.action == "inventory.updated"
            && entry.actor.contains(&staff.session_id)
            && entry.details.contains(&format!("inventory_id={}", item.id))
    }));
}

#[test]
fn inventory_and_configuration_survive_an_upgrade() {
    let (pic, canister, agent) = setup();
    let item = add_stock(&pic, canister);
    let branding = HashMap::from([
        (
            "storefront_business_name".to_string(),
            ConfigValue::Text("Upgrade Shop".to_string()),
        ),
        (
            "storefront_logo_url".to_string(),
            ConfigValue::Text("https://cdn.example/upgrade-logo.png".to_string()),
        ),
        (
            "ic_domains".to_string(),
            ConfigValue::Text("upgrade.example.com".to_string()),
        ),
    ]);
    let (configured,): (Result<(), String>,) =
        update_candid_as(&pic, canister, principal(1), "set_config", (branding,)).unwrap();
    configured.unwrap();

    pic.upgrade_canister(
        canister,
        WASM.to_vec(),
        encode_one(()).unwrap(),
        Some(principal(1)),
    )
    .unwrap();

    let (stored,): (Option<InventoryItem>,) =
        query_candid(&pic, canister, "get_inventory", (item.id,)).unwrap();
    assert_eq!(stored, Some(item));
    let (settings,): (Result<Settings, order_inventory::OrderError>,) =
        query_candid_as(&pic, canister, principal(1), "get_settings", ()).unwrap();
    assert!(settings.unwrap().trusted_agents.contains(&agent));

    let page = http_get(&pic, canister, "/");
    let cookie = page
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, value)| value.as_str())
        .expect("ic_env cookie after upgrade");
    assert!(cookie.contains("storefront_business_name%3DUpgrade%20Shop"));
    assert!(cookie.contains("storefront_logo_url%3Dhttps%3A%2F%2Fcdn.example%2Fupgrade-logo.png"));
    let domains = http_get(&pic, canister, "/.well-known/ic-domains");
    assert_eq!(domains.status_code, 200);
    assert_eq!(domains.body, b"upgrade.example.com\n");
}

#[derive(candid::CandidType, serde::Deserialize)]
struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(candid::CandidType, serde::Deserialize)]
struct HttpResponse {
    status_code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(candid::CandidType, serde::Deserialize, Debug, PartialEq, Eq)]
enum LinkKind {
    Admin,
    Public,
}

#[derive(candid::CandidType, serde::Deserialize, Debug, PartialEq, Eq)]
struct CanisterLink {
    label: String,
    url: String,
    kind: LinkKind,
}

fn http_get(pic: &PocketIc, canister: Principal, url: &str) -> HttpResponse {
    let request = HttpRequest {
        method: "GET".to_string(),
        url: url.to_string(),
        headers: Vec::new(),
        body: Vec::new(),
    };
    let (response,): (HttpResponse,) =
        query_candid(pic, canister, "http_request", (request,)).unwrap();
    response
}

#[test]
fn dashboard_can_find_and_load_the_embedded_inventory_ui() {
    let (pic, canister, _) = setup();

    let (links,): (Vec<CanisterLink>,) = query_candid(&pic, canister, "get_links", ()).unwrap();
    assert_eq!(
        links,
        vec![
            CanisterLink {
                label: "Inventory Admin".to_string(),
                url: "/admin/".to_string(),
                kind: LinkKind::Admin,
            },
            CanisterLink {
                label: "Storefront".to_string(),
                url: "/".to_string(),
                kind: LinkKind::Public,
            },
        ]
    );

    let page = http_get(&pic, canister, "/admin/");
    assert_eq!(page.status_code, 200);
    assert!(page.body.starts_with(b"<!doctype html>"));
    // the page learns its own canister id from this cookie
    let cookie = page
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, value)| value.as_str())
        .expect("ic_env cookie");
    assert!(cookie.starts_with("ic_env="));
    assert!(cookie.contains("PUBLIC_CANISTER_ID%3Abackend%3D"));

    let storefront = http_get(&pic, canister, "/");
    assert_eq!(storefront.status_code, 200);
    assert!(storefront.body.starts_with(b"<!doctype html>"));
    assert!(!String::from_utf8(storefront.body)
        .unwrap()
        .contains("/admin/assets/"));
}

#[test]
fn dynamic_settings_update_branding_cookie_and_certified_custom_domains() {
    let (pic, canister, _) = setup();
    let admin = principal(1);
    let storage = principal(8);

    let (schema,): (Vec<ConfigFieldSchema>,) =
        query_candid(&pic, canister, "get_config_schema", ()).unwrap();
    let field = schema
        .iter()
        .find(|field| field.key == "storage_canister")
        .expect("storage picker schema");
    assert_eq!(field.label, "Storage Canister ID");
    assert!(!field.readonly());

    let project = schema
        .iter()
        .find(|field| field.key == "project_id")
        .expect("project-id schema");
    assert_eq!(project.group.as_deref(), Some("protocol"));

    let protocol = schema
        .iter()
        .find(|field| field.key == "protocol_id")
        .expect("protocol schema");
    assert!(matches!(
        protocol.default_value.as_ref(),
        Some(ConfigValue::PrincipalId(id))
            if id.to_text() == "ibrml-ld777-77774-qaabq-cai"
    ));

    let business_name = schema
        .iter()
        .find(|field| field.key == "storefront_business_name")
        .expect("storefront business-name schema");
    assert_eq!(business_name.label, "Business Name");
    assert_eq!(business_name.group.as_deref(), Some("storefront_branding"));

    let logo_url = schema
        .iter()
        .find(|field| field.key == "storefront_logo_url")
        .expect("storefront logo schema");
    assert_eq!(logo_url.label, "Logo URL");
    assert_eq!(logo_url.group.as_deref(), Some("storefront_branding"));

    let domains = schema
        .iter()
        .find(|field| field.key == "ic_domains")
        .expect("custom-domains schema");
    assert_eq!(domains.label, "Custom Domains");
    assert_eq!(domains.field_type, ConfigType::TextArea);
    assert_eq!(domains.group.as_deref(), Some("custom_domains"));

    let update = HashMap::from([
        (
            "storage_canister".to_string(),
            ConfigValue::PrincipalId(storage),
        ),
        (
            "storefront_business_name".to_string(),
            ConfigValue::Text("Acme & Sons".to_string()),
        ),
        (
            "storefront_logo_url".to_string(),
            ConfigValue::Text("https://cdn.example/logo mark.png".to_string()),
        ),
        (
            "ic_domains".to_string(),
            ConfigValue::Text(
                " Shop.Example.com \r\nwww.shop.example.com\nshop.example.com".to_string(),
            ),
        ),
    ]);
    let (configured,): (Result<(), String>,) =
        update_candid_as(&pic, canister, admin, "set_config", (update,)).unwrap();
    configured.unwrap();

    let page = http_get(&pic, canister, "/admin/");
    let cookie = page
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, value)| value.as_str())
        .expect("ic_env cookie");
    assert!(cookie.contains(&format!("storage_canister_id%3D{}", storage.to_text())));
    assert!(cookie.contains("storefront_business_name%3DAcme%20%26%20Sons"));
    assert!(cookie.contains("storefront_logo_url%3Dhttps%3A%2F%2Fcdn.example%2Flogo%20mark.png"));

    let domains = http_get(&pic, canister, "/.well-known/ic-domains");
    assert_eq!(domains.status_code, 200);
    assert_eq!(domains.body, b"shop.example.com\nwww.shop.example.com\n");
    assert!(domains
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
    assert!(!domains
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("set-cookie")));
}

#[test]
fn item_image_url_can_be_set_replaced_cleared_and_must_be_http() {
    let (pic, canister, _) = setup();
    let admin = principal(1);
    let item = add_stock(&pic, canister);
    assert_eq!(item.image_url, None);

    let set = |image_url: &str| -> Result<InventoryItem, order_inventory::OrderError> {
        let update = UpdateInventoryItem {
            image_url: Some(image_url.to_string()),
            ..Default::default()
        };
        let (result,): (Result<InventoryItem, order_inventory::OrderError>,) =
            update_candid_as(&pic, canister, admin, "update_inventory", (item.id, update)).unwrap();
        result
    };

    let url = "https://abc-cai.icp0.io/inventory/x/cocoa.png";
    assert_eq!(set(url).unwrap().image_url.as_deref(), Some(url));
    // other updates leave the image alone
    let (renamed,): (Result<InventoryItem, order_inventory::OrderError>,) = update_candid_as(
        &pic,
        canister,
        admin,
        "update_inventory",
        (
            item.id,
            UpdateInventoryItem {
                name: Some("Cocoa crate".to_string()),
                ..Default::default()
            },
        ),
    )
    .unwrap();
    assert_eq!(renamed.unwrap().image_url.as_deref(), Some(url));

    assert!(set("javascript:alert(1)").is_err());
    assert!(set(&format!("https://x/{}", "a".repeat(3000))).is_err());
    // an empty string removes it
    assert_eq!(set("").unwrap().image_url, None);
}

// ---------------------------------------------------------------------------
// Public storefront: signed-in customers order directly, no agent involved
// ---------------------------------------------------------------------------

fn storefront_order(item_id: u64, quantity: u64) -> order_inventory::PlaceOrder {
    order_inventory::PlaceOrder {
        items: vec![order_inventory::OrderItemRequest {
            inventory_id: item_id,
            quantity,
        }],
        customer_name: Some("Amaka".to_string()),
        customer_phone: Some("+2348031234567".to_string()),
        delivery_location: order_inventory::DeliveryLocation {
            address: "14 Allen Avenue, Ikeja".to_string(),
            latitude: None,
            longitude: None,
            instructions: None,
        },
        note: None,
        payment_method: None,
    }
}

fn place_as(
    pic: &PocketIc,
    canister: Principal,
    caller: Principal,
    input: order_inventory::PlaceOrder,
) -> Result<Order, order_inventory::OrderError> {
    let (result,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(pic, canister, caller, "place_order", (input,)).unwrap();
    result
}

fn my_orders(
    pic: &PocketIc,
    canister: Principal,
    caller: Principal,
) -> Result<Vec<Order>, order_inventory::OrderError> {
    let (result,): (Result<Vec<Order>, order_inventory::OrderError>,) =
        query_candid_as(pic, canister, caller, "list_my_orders", ()).unwrap();
    result
}

fn stock_of(pic: &PocketIc, canister: Principal, id: u64) -> Option<u64> {
    let (item,): (Option<InventoryItem>,) =
        query_candid(pic, canister, "get_inventory", (id,)).unwrap();
    item.unwrap().stock_quantity
}

#[test]
fn storefront_requires_a_signed_in_caller() {
    let (pic, canister, _) = setup();
    let item = add_stock(&pic, canister);
    let anonymous = Principal::anonymous();
    assert!(matches!(
        place_as(&pic, canister, anonymous, storefront_order(item.id, 1)),
        Err(order_inventory::OrderError::Unauthorized(_))
    ));
    assert!(matches!(
        my_orders(&pic, canister, anonymous),
        Err(order_inventory::OrderError::Unauthorized(_))
    ));
    assert_eq!(
        stock_of(&pic, canister, item.id),
        Some(5),
        "nothing was reserved"
    );
}

#[test]
fn storefront_customer_orders_as_themselves_and_only_sees_their_own_orders() {
    let (pic, canister, _) = setup();
    let item = add_stock(&pic, canister);
    let (amaka, tunde) = (principal(10), principal(11));

    let order = place_as(&pic, canister, amaka, storefront_order(item.id, 2)).unwrap();
    // The customer identity is the caller, on the Web channel - never anything
    // the request supplied - and the price comes from inventory.
    assert_eq!(order.customer.channel, AiChannel::Web);
    assert_eq!(order.customer.session_id, amaka.to_text());
    assert_eq!(order.total_minor, 5_000);
    assert_eq!(order.payment_method, PaymentMethod::CashOnDelivery);
    assert_eq!(stock_of(&pic, canister, item.id), Some(3));

    let mine = my_orders(&pic, canister, amaka).unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].id, order.id);
    assert!(my_orders(&pic, canister, tunde).unwrap().is_empty());
}

#[test]
fn storefront_orders_are_listed_newest_first() {
    let (pic, canister, _) = setup();
    let item = add_stock(&pic, canister);
    let amaka = principal(10);
    let first = place_as(&pic, canister, amaka, storefront_order(item.id, 1)).unwrap();
    let second = place_as(&pic, canister, amaka, storefront_order(item.id, 1)).unwrap();
    let ids: Vec<u64> = my_orders(&pic, canister, amaka)
        .unwrap()
        .iter()
        .map(|o| o.id)
        .collect();
    assert_eq!(ids, vec![second.id, first.id]);
}

#[test]
fn storefront_customer_can_cancel_only_their_own_pending_order() {
    let (pic, canister, _) = setup();
    let item = add_stock(&pic, canister);
    let (amaka, tunde) = (principal(10), principal(11));
    let order = place_as(&pic, canister, amaka, storefront_order(item.id, 2)).unwrap();

    let (other,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, tunde, "cancel_my_order", (order.id,)).unwrap();
    assert!(matches!(
        other,
        Err(order_inventory::OrderError::NotFound(_))
    ));
    assert_eq!(
        stock_of(&pic, canister, item.id),
        Some(3),
        "another customer cannot release stock"
    );

    let (own,): (Result<Order, order_inventory::OrderError>,) =
        update_candid_as(&pic, canister, amaka, "cancel_my_order", (order.id,)).unwrap();
    assert_eq!(own.unwrap().status, OrderStatus::Cancelled);
    assert_eq!(
        stock_of(&pic, canister, item.id),
        Some(5),
        "stock is restored"
    );
}

#[test]
fn storefront_customer_cannot_oversell_or_hoard_stock_with_open_orders() {
    let (pic, canister, _) = setup();
    let item = add_stock(&pic, canister); // 5 in stock
    let amaka = principal(10);
    assert!(matches!(
        place_as(&pic, canister, amaka, storefront_order(item.id, 6)),
        Err(order_inventory::OrderError::Conflict(_))
    ));
    for _ in 0..5 {
        place_as(&pic, canister, amaka, storefront_order(item.id, 1)).unwrap();
    }
    // Stock is gone anyway, so use a second item to hit the open-order cap.
    let other = {
        let input = CreateInventoryItem {
            name: "Palm oil".to_string(),
            description: String::new(),
            sku: None,
            kind: InventoryKind::Product,
            price_minor: 1_000,
            currency: "NGN".to_string(),
            image_url: None,
            stock_quantity: Some(50),
        };
        let (r,): (Result<InventoryItem, order_inventory::OrderError>,) =
            update_candid_as(&pic, canister, principal(1), "create_inventory", (input,)).unwrap();
        r.unwrap()
    };
    let err = place_as(&pic, canister, amaka, storefront_order(other.id, 1)).unwrap_err();
    assert!(matches!(err, order_inventory::OrderError::Conflict(m) if m.contains("waiting")));
    // A different customer is unaffected by Amaka's open orders.
    assert!(place_as(&pic, canister, principal(11), storefront_order(other.id, 1)).is_ok());
}
