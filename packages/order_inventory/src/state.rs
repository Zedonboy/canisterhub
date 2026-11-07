use crate::types::{
    AuditEntry, BusinessProfile, CreateInventoryItem, CustomerIdentity, InventoryItem, Order,
    OrderError, OrderLine, OrderStatus, PaymentMethod, PaymentRecord, PaymentStatus, PlaceOrder,
    RecordCashCollection, RecordPayment, RecordPaymentFailure, RecordRefund, Settings,
    UpdateInventoryItem,
};
use candid::Principal;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use std::{borrow::Cow, cell::RefCell, collections::BTreeMap};

type Memory = VirtualMemory<DefaultMemoryImpl>;

const INVENTORY_MEMORY_ID: MemoryId = MemoryId::new(0);
const ORDERS_MEMORY_ID: MemoryId = MemoryId::new(1);
const NEXT_INVENTORY_ID_MEMORY_ID: MemoryId = MemoryId::new(2);
const NEXT_ORDER_ID_MEMORY_ID: MemoryId = MemoryId::new(3);
const SETTINGS_MEMORY_ID: MemoryId = MemoryId::new(4);
const DYNAMIC_CONFIG_MEMORY_ID: MemoryId = MemoryId::new(5);
const PAYMENTS_MEMORY_ID: MemoryId = MemoryId::new(6);
const TRANSACTIONS_MEMORY_ID: MemoryId = MemoryId::new(7);
const AUDIT_MEMORY_ID: MemoryId = MemoryId::new(8);
const NEXT_AUDIT_ID_MEMORY_ID: MemoryId = MemoryId::new(9);
const PROJECT_MEMBERS_MEMORY_ID: MemoryId = MemoryId::new(10);

macro_rules! stable_cbor {
    ($type:ty) => {
        impl Storable for $type {
            const BOUND: Bound = Bound::Unbounded;

            fn to_bytes(&self) -> Cow<'_, [u8]> {
                let mut bytes = Vec::new();
                ciborium::into_writer(self, &mut bytes).expect("failed to encode stable value");
                Cow::Owned(bytes)
            }

            fn into_bytes(self) -> Vec<u8> {
                self.to_bytes().into_owned()
            }

            fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
                ciborium::from_reader(bytes.as_ref()).expect("failed to decode stable value")
            }
        }
    };
}

stable_cbor!(InventoryItem);
stable_cbor!(Order);
stable_cbor!(Settings);
stable_cbor!(PaymentRecord);
stable_cbor!(AuditEntry);

#[derive(candid::CandidType, serde::Serialize, serde::Deserialize, Clone, Default)]
struct ProjectMembers(Vec<Principal>);
stable_cbor!(ProjectMembers);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static INVENTORY: RefCell<StableBTreeMap<u64, InventoryItem, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(INVENTORY_MEMORY_ID)))
    );
    static ORDERS: RefCell<StableBTreeMap<u64, Order, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ORDERS_MEMORY_ID)))
    );
    static NEXT_INVENTORY_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(NEXT_INVENTORY_ID_MEMORY_ID)), 1)
    );
    static NEXT_ORDER_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(NEXT_ORDER_ID_MEMORY_ID)), 1)
    );
    static SETTINGS: RefCell<StableCell<Settings, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(SETTINGS_MEMORY_ID)), Settings::default())
    );
    static PAYMENTS: RefCell<StableBTreeMap<u64, PaymentRecord, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PAYMENTS_MEMORY_ID)))
    );
    static TRANSACTIONS: RefCell<StableBTreeMap<Vec<u8>, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(TRANSACTIONS_MEMORY_ID)))
    );
    static AUDIT: RefCell<StableBTreeMap<u64, AuditEntry, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(AUDIT_MEMORY_ID)))
    );
    static NEXT_AUDIT_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(NEXT_AUDIT_ID_MEMORY_ID)), 1)
    );
    static PROJECT_MEMBERS: RefCell<StableCell<ProjectMembers, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROJECT_MEMBERS_MEMORY_ID)), ProjectMembers::default())
    );
}

pub fn set_project_members(members: Vec<Principal>) {
    PROJECT_MEMBERS.with(|cell| {
        cell.borrow_mut().set(ProjectMembers(members));
    });
}

#[cfg(not(target_arch = "wasm32"))]
pub fn is_project_member(principal: Principal) -> bool {
    PROJECT_MEMBERS.with(|cell| cell.borrow().get().0.contains(&principal))
}

fn audit(order_id: Option<u64>, actor: &str, action: &str, details: String, now: u64) {
    let id = NEXT_AUDIT_ID.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        if let Some(next) = id.checked_add(1) {
            counter.set(next);
        }
        id
    });
    AUDIT.with(|entries| {
        entries.borrow_mut().insert(
            id,
            AuditEntry {
                id,
                order_id,
                actor: actor.to_string(),
                action: action.to_string(),
                details,
                at: now,
            },
        )
    });
}

fn transaction_key(kind: &str, provider: &str, transaction_id: &str) -> Vec<u8> {
    format!("{kind}\0{provider}\0{transaction_id}").into_bytes()
}

fn take_id(
    cell: &'static std::thread::LocalKey<RefCell<StableCell<u64, Memory>>>,
) -> Result<u64, OrderError> {
    cell.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        let next = id
            .checked_add(1)
            .ok_or_else(|| OrderError::Internal("id space exhausted".to_string()))?;
        counter.set(next);
        Ok(id)
    })
}

/// Opens the SDK-managed runtime config (see `config.rs`) on its own
/// stable-memory region. Must run from both `init` and `post_upgrade`.
pub fn init_dynamic_config_store() {
    canister_hub_sdk::ic::config::init_stable_store::<crate::config::Config>(
        MEMORY_MANAGER.with(|m| m.borrow().get(DYNAMIC_CONFIG_MEMORY_ID)),
    );
    canister_hub_sdk::ic::config::set_change_hook(crate::assets::certify);
    migrate_legacy_orders(ic_cdk::api::time());
}

fn migrate_legacy_orders(now: u64) {
    let orders: Vec<Order> =
        ORDERS.with(|stored| stored.borrow().iter().map(|entry| entry.value()).collect());
    for mut order in orders {
        if get_payment(order.id).is_some() {
            continue;
        }
        let reference = order
            .payment_reference
            .clone()
            .unwrap_or_else(|| format!("order-{}-{}", ic_cdk::api::canister_self(), order.id));
        order.payment_reference = Some(reference.clone());
        ORDERS.with(|stored| stored.borrow_mut().insert(order.id, order.clone()));
        PAYMENTS.with(|payments| {
            payments.borrow_mut().insert(
                order.id,
                PaymentRecord {
                    order_id: order.id,
                    method: order.payment_method,
                    status: order.payment_status,
                    expected_amount_minor: order.total_minor,
                    currency: order.currency.clone(),
                    merchant_reference: reference,
                    amount_paid_minor: order.amount_paid_minor,
                    amount_refunded_minor: order.amount_refunded_minor,
                    provider: None,
                    provider_transaction_id: None,
                    last_failure: None,
                    created_at: order.created_at,
                    updated_at: now.max(order.updated_at),
                },
            )
        });
        audit(
            Some(order.id),
            "system:migration",
            "order.payment_migrated",
            "legacy order initialized as cash on delivery".to_string(),
            now,
        );
    }
}

pub fn settings() -> Settings {
    SETTINGS.with(|settings| settings.borrow().get().clone())
}

pub fn update_settings(value: Settings) {
    SETTINGS.with(|settings| settings.borrow_mut().set(value));
}

pub fn set_business(business: BusinessProfile) {
    let mut value = settings();
    value.business = business;
    update_settings(value);
}

pub fn set_trusted_agent(agent: Principal, enabled: bool) {
    let mut value = settings();
    value.trusted_agents.retain(|candidate| *candidate != agent);
    if enabled {
        value.trusted_agents.push(agent);
    }
    update_settings(value);
}

pub fn set_staff(identity: CustomerIdentity, enabled: bool) {
    let mut value = settings();
    value.staff.retain(|candidate| candidate != &identity);
    if enabled {
        value.staff.push(identity);
    }
    update_settings(value);
}

pub fn set_payment_processor(processor: Principal, enabled: bool) {
    let mut value = settings();
    value
        .trusted_payment_processors
        .retain(|candidate| *candidate != processor);
    if enabled {
        value.trusted_payment_processors.push(processor);
    }
    update_settings(value);
}

pub fn set_reservation_ttl_ns(ttl: u64) {
    let mut value = settings();
    value.prepaid_reservation_ttl_ns = ttl;
    update_settings(value);
}

pub fn create_inventory(
    input: CreateInventoryItem,
    actor: &str,
    now: u64,
) -> Result<InventoryItem, OrderError> {
    let id = take_id(&NEXT_INVENTORY_ID)?;
    let item = InventoryItem {
        id,
        name: input.name,
        description: input.description,
        sku: input.sku,
        kind: input.kind,
        price_minor: input.price_minor,
        currency: input.currency,
        payment_method: input.payment_method.unwrap_or_default(),
        image_url: input.image_url,
        stock_quantity: input.stock_quantity,
        active: true,
        created_at: now,
        updated_at: now,
    };
    INVENTORY.with(|items| items.borrow_mut().insert(id, item.clone()));
    audit(
        None,
        actor,
        "inventory.created",
        format!(
            "inventory_id={}; name={}; price_minor={}; currency={}; stock_quantity={:?}",
            item.id, item.name, item.price_minor, item.currency, item.stock_quantity
        ),
        now,
    );
    Ok(item)
}

pub fn update_inventory(
    id: u64,
    input: UpdateInventoryItem,
    actor: &str,
    now: u64,
) -> Result<InventoryItem, OrderError> {
    let item = INVENTORY.with(|items| {
        let mut items = items.borrow_mut();
        let mut item = items
            .get(&id)
            .ok_or_else(|| OrderError::NotFound("inventory item not found".to_string()))?;
        if let Some(value) = input.name {
            item.name = value;
        }
        if let Some(value) = input.description {
            item.description = value;
        }
        if let Some(value) = input.sku {
            item.sku = Some(value);
        }
        if let Some(value) = input.kind {
            item.kind = value;
        }
        if let Some(value) = input.price_minor {
            item.price_minor = value;
        }
        if let Some(value) = input.currency {
            item.currency = value;
        }
        if let Some(value) = input.payment_method {
            item.payment_method = value;
        }
        if let Some(value) = input.image_url {
            item.image_url = (!value.is_empty()).then_some(value);
        }
        match input.track_stock {
            Some(false) => item.stock_quantity = None,
            Some(true) => {
                item.stock_quantity = Some(
                    input
                        .stock_quantity
                        .unwrap_or(item.stock_quantity.unwrap_or(0)),
                )
            }
            None if input.stock_quantity.is_some() => item.stock_quantity = input.stock_quantity,
            None => {}
        }
        if let Some(value) = input.active {
            item.active = value;
        }
        item.updated_at = now;
        items.insert(id, item.clone());
        Ok(item)
    })?;
    audit(
        None,
        actor,
        "inventory.updated",
        format!(
            "inventory_id={}; name={}; price_minor={}; currency={}; stock_quantity={:?}; active={}",
            item.id, item.name, item.price_minor, item.currency, item.stock_quantity, item.active
        ),
        now,
    );
    Ok(item)
}

pub fn get_inventory(id: u64) -> Option<InventoryItem> {
    INVENTORY.with(|items| items.borrow().get(&id))
}

pub fn list_inventory(active_only: bool) -> Vec<InventoryItem> {
    INVENTORY.with(|items| {
        items
            .borrow()
            .iter()
            .filter_map(|entry| {
                let item = entry.value();
                (!active_only || item.active).then_some(item)
            })
            .collect()
    })
}

pub fn place_order(
    customer: CustomerIdentity,
    agent_canister_id: Option<Principal>,
    input: PlaceOrder,
    actor: &str,
    now: u64,
) -> Result<Order, OrderError> {
    let mut quantities = BTreeMap::<u64, u64>::new();
    for requested in input.items {
        let total = quantities.entry(requested.inventory_id).or_default();
        *total = total
            .checked_add(requested.quantity)
            .ok_or_else(|| OrderError::InvalidInput("item quantity is too large".to_string()))?;
    }

    let mut lines = Vec::with_capacity(quantities.len());
    let mut total_minor = 0u64;
    let mut order_currency: Option<String> = None;
    let mut order_payment_method: Option<PaymentMethod> = None;
    for (inventory_id, quantity) in &quantities {
        let item = get_inventory(*inventory_id).ok_or_else(|| {
            OrderError::NotFound(format!("inventory item {inventory_id} not found"))
        })?;
        if !item.active {
            return Err(OrderError::Conflict(format!(
                "{} is not available",
                item.name
            )));
        }
        match order_payment_method {
            Some(method) if method != item.payment_method => {
                return Err(OrderError::Conflict(
                    "items with different vendor payment terms must be placed in separate orders".to_string(),
                ));
            }
            None => order_payment_method = Some(item.payment_method),
            _ => {}
        }
        if let Some(available) = item.stock_quantity {
            if *quantity > available {
                return Err(OrderError::Conflict(format!(
                    "only {available} units of {} are available",
                    item.name
                )));
            }
        }
        if let Some(currency) = &order_currency {
            if currency != &item.currency {
                return Err(OrderError::Conflict(
                    "all order items must use the same currency".to_string(),
                ));
            }
        } else {
            order_currency = Some(item.currency.clone());
        }
        let line_total_minor = item
            .price_minor
            .checked_mul(*quantity)
            .ok_or_else(|| OrderError::InvalidInput("order total is too large".to_string()))?;
        total_minor = total_minor
            .checked_add(line_total_minor)
            .ok_or_else(|| OrderError::InvalidInput("order total is too large".to_string()))?;
        lines.push(OrderLine {
            inventory_id: *inventory_id,
            name: item.name,
            sku: item.sku.clone(),
            kind: item.kind,
            unit_price_minor: item.price_minor,
            quantity: *quantity,
            line_total_minor,
        });
    }

    let payment_method = order_payment_method.unwrap_or_default();

    let id = take_id(&NEXT_ORDER_ID)?;
    INVENTORY.with(|items| {
        let mut items = items.borrow_mut();
        for (inventory_id, quantity) in &quantities {
            let mut item = items.get(inventory_id).expect("inventory was validated");
            if let Some(available) = item.stock_quantity {
                item.stock_quantity = Some(available - quantity);
                item.updated_at = now;
                items.insert(*inventory_id, item);
            }
        }
    });
    let merchant_reference = format!("order-{}-{id}", ic_cdk::api::canister_self());
    let (status, payment_status, reservation_expires_at) = match payment_method {
        PaymentMethod::Prepaid => (
            OrderStatus::AwaitingPayment,
            PaymentStatus::AwaitingPayment,
            Some(now.saturating_add(settings().prepaid_reservation_ttl_ns)),
        ),
        PaymentMethod::CashOnDelivery => (
            OrderStatus::Pending,
            PaymentStatus::CashOnDeliveryPending,
            None,
        ),
    };
    let currency = order_currency.unwrap_or_else(|| settings().business.currency);
    let order = Order {
        id,
        customer,
        agent_canister_id,
        customer_name: input.customer_name,
        customer_phone: input.customer_phone,
        customer_email: input.customer_email,
        items: lines,
        total_minor,
        currency: currency.clone(),
        delivery_location: input.delivery_location,
        note: input.note,
        status,
        created_at: now,
        updated_at: now,
        payment_method,
        payment_status,
        payment_reference: Some(merchant_reference.clone()),
        checkout_url: None,
        amount_paid_minor: 0,
        amount_refunded_minor: 0,
        reservation_expires_at,
        stock_released: false,
    };
    ORDERS.with(|orders| orders.borrow_mut().insert(id, order.clone()));
    PAYMENTS.with(|payments| {
        payments.borrow_mut().insert(
            id,
            PaymentRecord {
                order_id: id,
                method: payment_method,
                status: payment_status,
                expected_amount_minor: total_minor,
                currency,
                merchant_reference,
                amount_paid_minor: 0,
                amount_refunded_minor: 0,
                provider: None,
                provider_transaction_id: None,
                last_failure: None,
                created_at: now,
                updated_at: now,
            },
        )
    });
    audit(
        Some(id),
        actor,
        "order.placed",
        format!("method={payment_method:?}; total_minor={total_minor}"),
        now,
    );
    Ok(order)
}

pub fn set_checkout_url(id: u64, checkout_url: String, now: u64) -> Result<Order, OrderError> {
    let mut order = get_order(id).ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    if order.payment_method != PaymentMethod::Prepaid || order.payment_status != PaymentStatus::AwaitingPayment {
        return Err(OrderError::Conflict("checkout can only be attached to an unpaid prepaid order".to_string()));
    }
    order.checkout_url = Some(checkout_url);
    order.updated_at = now;
    ORDERS.with(|orders| orders.borrow_mut().insert(id, order.clone()));
    Ok(order)
}

pub fn get_order(id: u64) -> Option<Order> {
    ORDERS.with(|orders| orders.borrow().get(&id))
}

pub fn list_orders(status: Option<OrderStatus>) -> Vec<Order> {
    ORDERS.with(|orders| {
        orders
            .borrow()
            .iter()
            .filter_map(|entry| {
                let order = entry.value();
                (status.is_none() || status == Some(order.status)).then_some(order)
            })
            .collect()
    })
}

pub fn list_customer_orders(customer: &CustomerIdentity) -> Vec<Order> {
    ORDERS.with(|orders| {
        orders
            .borrow()
            .iter()
            .filter_map(|entry| {
                let order = entry.value();
                (&order.customer == customer).then_some(order)
            })
            .collect()
    })
}

pub fn get_payment(order_id: u64) -> Option<PaymentRecord> {
    PAYMENTS.with(|payments| payments.borrow().get(&order_id))
}

fn update_payment_status(order_id: u64, status: PaymentStatus, now: u64) {
    PAYMENTS.with(|payments| {
        let mut payments = payments.borrow_mut();
        if let Some(mut payment) = payments.get(&order_id) {
            payment.status = status;
            payment.updated_at = now;
            payments.insert(order_id, payment);
        }
    });
}

pub fn record_payment(input: RecordPayment, actor: &str, now: u64) -> Result<Order, OrderError> {
    let key = transaction_key("payment", &input.provider, &input.transaction_id);
    if let Some(existing_order) = TRANSACTIONS.with(|transactions| transactions.borrow().get(&key))
    {
        if existing_order == input.order_id {
            return get_order(input.order_id).ok_or_else(|| {
                OrderError::Internal("payment points to a missing order".to_string())
            });
        }
        return Err(OrderError::Conflict(
            "provider transaction is already attached to another order".to_string(),
        ));
    }

    let mut order = get_order(input.order_id)
        .ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    let mut payment = get_payment(input.order_id)
        .ok_or_else(|| OrderError::Internal("payment record not found".to_string()))?;
    if order.payment_method != PaymentMethod::Prepaid {
        return Err(OrderError::Conflict(
            "cash-on-delivery orders cannot receive prepaid confirmation".to_string(),
        ));
    }
    if matches!(order.status, OrderStatus::Cancelled | OrderStatus::Expired) {
        return Err(OrderError::Conflict(
            "cancelled or expired orders cannot accept payment".to_string(),
        ));
    }
    if order.payment_status == PaymentStatus::Paid {
        return Err(OrderError::Conflict(
            "order is already paid with a different transaction".to_string(),
        ));
    }
    if order
        .reservation_expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return Err(OrderError::Conflict(
            "prepaid reservation has expired".to_string(),
        ));
    }
    if order.payment_reference.as_deref() != Some(input.merchant_reference.as_str()) {
        return Err(OrderError::Conflict(
            "merchant payment reference does not match the order".to_string(),
        ));
    }
    if input.amount_minor != order.total_minor || input.currency != order.currency {
        return Err(OrderError::Conflict(format!(
            "payment must exactly match {} {} minor units",
            order.total_minor, order.currency
        )));
    }

    order.amount_paid_minor = input.amount_minor;
    order.payment_status = PaymentStatus::Paid;
    order.reservation_expires_at = None;
    if order.status == OrderStatus::AwaitingPayment {
        order.status = OrderStatus::Pending;
    }
    order.updated_at = now;

    payment.status = PaymentStatus::Paid;
    payment.amount_paid_minor = input.amount_minor;
    payment.provider = Some(input.provider.clone());
    payment.provider_transaction_id = Some(input.transaction_id.clone());
    payment.last_failure = None;
    payment.updated_at = now;

    ORDERS.with(|orders| orders.borrow_mut().insert(order.id, order.clone()));
    PAYMENTS.with(|payments| payments.borrow_mut().insert(order.id, payment));
    TRANSACTIONS.with(|transactions| transactions.borrow_mut().insert(key, order.id));
    audit(
        Some(order.id),
        actor,
        "payment.verified",
        format!(
            "provider={}; transaction_id={}; merchant_reference={}; amount_minor={}",
            input.provider, input.transaction_id, input.merchant_reference, input.amount_minor
        ),
        now,
    );
    Ok(order)
}

pub fn record_payment_failure(
    input: RecordPaymentFailure,
    actor: &str,
    now: u64,
) -> Result<PaymentRecord, OrderError> {
    let order = get_order(input.order_id)
        .ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    if order.payment_method != PaymentMethod::Prepaid {
        return Err(OrderError::Conflict(
            "cash-on-delivery order has no prepaid attempt".to_string(),
        ));
    }
    if order.payment_status == PaymentStatus::Paid {
        return Err(OrderError::Conflict(
            "paid order cannot fail payment".to_string(),
        ));
    }
    let mut payment = get_payment(input.order_id)
        .ok_or_else(|| OrderError::Internal("payment record not found".to_string()))?;
    if payment.merchant_reference != input.reference {
        return Err(OrderError::Conflict(
            "merchant payment reference does not match the order".to_string(),
        ));
    }
    payment.status = PaymentStatus::Failed;
    payment.provider = Some(input.provider.clone());
    payment.last_failure = Some(input.reason.clone());
    payment.updated_at = now;
    PAYMENTS.with(|payments| {
        payments
            .borrow_mut()
            .insert(input.order_id, payment.clone())
    });
    ORDERS.with(|orders| {
        let mut orders = orders.borrow_mut();
        if let Some(mut order) = orders.get(&input.order_id) {
            order.payment_status = PaymentStatus::Failed;
            order.updated_at = now;
            orders.insert(order.id, order);
        }
    });
    audit(
        Some(input.order_id),
        actor,
        "payment.failed",
        format!(
            "provider={}; reference={}; reason={}",
            input.provider, input.reference, input.reason
        ),
        now,
    );
    Ok(payment)
}

pub fn record_refund(input: RecordRefund, actor: &str, now: u64) -> Result<Order, OrderError> {
    let key = transaction_key("refund", &input.provider, &input.transaction_id);
    if let Some(existing_order) = TRANSACTIONS.with(|transactions| transactions.borrow().get(&key))
    {
        if existing_order == input.order_id {
            return get_order(input.order_id).ok_or_else(|| {
                OrderError::Internal("refund points to a missing order".to_string())
            });
        }
        return Err(OrderError::Conflict(
            "refund transaction is already attached to another order".to_string(),
        ));
    }
    if input.amount_minor == 0 {
        return Err(OrderError::InvalidInput(
            "refund amount must be greater than zero".to_string(),
        ));
    }

    let mut order = get_order(input.order_id)
        .ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    let refundable = order
        .amount_paid_minor
        .checked_sub(order.amount_refunded_minor)
        .ok_or_else(|| OrderError::Internal("refunded amount exceeds paid amount".to_string()))?;
    if input.amount_minor > refundable {
        return Err(OrderError::Conflict(format!(
            "refund exceeds remaining refundable amount of {refundable}"
        )));
    }
    order.amount_refunded_minor += input.amount_minor;
    order.payment_status = if order.amount_refunded_minor == order.amount_paid_minor {
        PaymentStatus::Refunded
    } else {
        PaymentStatus::PartiallyRefunded
    };
    order.updated_at = now;

    let mut payment = get_payment(order.id)
        .ok_or_else(|| OrderError::Internal("payment record not found".to_string()))?;
    payment.amount_refunded_minor = order.amount_refunded_minor;
    payment.status = order.payment_status;
    payment.updated_at = now;

    ORDERS.with(|orders| orders.borrow_mut().insert(order.id, order.clone()));
    PAYMENTS.with(|payments| payments.borrow_mut().insert(order.id, payment));
    TRANSACTIONS.with(|transactions| transactions.borrow_mut().insert(key, order.id));
    audit(
        Some(order.id),
        actor,
        "refund.recorded",
        format!(
            "provider={}; transaction_id={}; amount_minor={}",
            input.provider, input.transaction_id, input.amount_minor
        ),
        now,
    );
    Ok(order)
}

pub fn record_cash_collection(
    input: RecordCashCollection,
    actor: &str,
    now: u64,
) -> Result<Order, OrderError> {
    let key = transaction_key("cash", "cash_on_delivery", &input.receipt_reference);
    if let Some(existing_order) = TRANSACTIONS.with(|transactions| transactions.borrow().get(&key))
    {
        if existing_order == input.order_id {
            return get_order(input.order_id).ok_or_else(|| {
                OrderError::Internal("receipt points to a missing order".to_string())
            });
        }
        return Err(OrderError::Conflict(
            "cash receipt is already attached to another order".to_string(),
        ));
    }
    let mut order = get_order(input.order_id)
        .ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    if order.payment_method != PaymentMethod::CashOnDelivery {
        return Err(OrderError::Conflict(
            "prepaid order cannot record cash on delivery".to_string(),
        ));
    }
    if matches!(order.status, OrderStatus::Cancelled | OrderStatus::Expired) {
        return Err(OrderError::Conflict(
            "cancelled order cannot collect payment".to_string(),
        ));
    }
    if !matches!(
        order.status,
        OrderStatus::Ready | OrderStatus::OutForDelivery
    ) {
        return Err(OrderError::Conflict(
            "cash on delivery can only be collected when an order is ready or out for delivery"
                .to_string(),
        ));
    }
    if input.amount_minor != order.total_minor || input.currency != order.currency {
        return Err(OrderError::Conflict(format!(
            "collection must exactly match {} {} minor units",
            order.total_minor, order.currency
        )));
    }
    order.amount_paid_minor = input.amount_minor;
    order.payment_status = PaymentStatus::CashOnDeliveryCollected;
    order.updated_at = now;
    let mut payment = get_payment(order.id)
        .ok_or_else(|| OrderError::Internal("payment record not found".to_string()))?;
    payment.amount_paid_minor = input.amount_minor;
    payment.status = PaymentStatus::CashOnDeliveryCollected;
    payment.provider = Some("cash_on_delivery".to_string());
    payment.provider_transaction_id = Some(input.receipt_reference.clone());
    payment.updated_at = now;
    ORDERS.with(|orders| orders.borrow_mut().insert(order.id, order.clone()));
    PAYMENTS.with(|payments| payments.borrow_mut().insert(order.id, payment));
    TRANSACTIONS.with(|transactions| transactions.borrow_mut().insert(key, order.id));
    audit(
        Some(order.id),
        actor,
        "cash_on_delivery.collected",
        format!(
            "receipt_reference={}; amount_minor={}",
            input.receipt_reference, input.amount_minor
        ),
        now,
    );
    Ok(order)
}

pub fn expire_unpaid_orders(limit: u64, actor: &str, now: u64) -> Result<u64, OrderError> {
    let candidates: Vec<u64> = ORDERS.with(|orders| {
        orders
            .borrow()
            .iter()
            .filter_map(|entry| {
                let order = entry.value();
                (order.status == OrderStatus::AwaitingPayment
                    && order
                        .reservation_expires_at
                        .is_some_and(|expires_at| expires_at <= now))
                .then_some(order.id)
            })
            .take(limit.min(100) as usize)
            .collect()
    });
    for id in &candidates {
        let mut order = get_order(*id)
            .ok_or_else(|| OrderError::Internal("expiring order disappeared".to_string()))?;
        release_stock(&mut order, now)?;
        order.status = OrderStatus::Expired;
        order.payment_status = PaymentStatus::Expired;
        order.updated_at = now;
        ORDERS.with(|orders| orders.borrow_mut().insert(*id, order));
        update_payment_status(*id, PaymentStatus::Expired, now);
        audit(
            Some(*id),
            actor,
            "order.expired",
            "unpaid reservation expired and stock was released".to_string(),
            now,
        );
    }
    Ok(candidates.len() as u64)
}

pub fn list_audit(order_id: Option<u64>, offset: u64, limit: u64) -> Vec<AuditEntry> {
    AUDIT.with(|entries| {
        entries
            .borrow()
            .iter()
            .rev()
            .filter_map(|entry| {
                let value = entry.value();
                (order_id.is_none() || value.order_id == order_id).then_some(value)
            })
            .skip(offset as usize)
            .take(limit.min(200) as usize)
            .collect()
    })
}

pub fn update_order_status(
    id: u64,
    next: OrderStatus,
    actor: &str,
    now: u64,
) -> Result<Order, OrderError> {
    ORDERS.with(|orders| {
        let mut orders = orders.borrow_mut();
        let mut order = orders
            .get(&id)
            .ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
        if !valid_transition(order.status, next) {
            return Err(OrderError::Conflict(format!(
                "cannot move order from {:?} to {:?}",
                order.status, next
            )));
        }
        if matches!(
            next,
            OrderStatus::Confirmed
                | OrderStatus::Preparing
                | OrderStatus::Ready
                | OrderStatus::OutForDelivery
        ) && order.payment_method == PaymentMethod::Prepaid
            && !matches!(
                order.payment_status,
                PaymentStatus::Paid | PaymentStatus::PartiallyRefunded
            )
        {
            return Err(OrderError::Conflict(
                "prepaid order cannot enter fulfillment before verified payment".to_string(),
            ));
        }
        if next == OrderStatus::Completed {
            let paid = matches!(
                order.payment_status,
                PaymentStatus::Paid | PaymentStatus::CashOnDeliveryCollected
            );
            if !paid {
                return Err(OrderError::Conflict(
                    "order cannot be completed before payment is collected".to_string(),
                ));
            }
        }
        if next == OrderStatus::Cancelled {
            release_stock(&mut order, now)?;
            if order.amount_paid_minor > order.amount_refunded_minor {
                order.payment_status = PaymentStatus::RefundPending;
                update_payment_status(id, PaymentStatus::RefundPending, now);
                audit(
                    Some(id),
                    actor,
                    "refund.requested",
                    format!(
                        "amount_minor={}",
                        order.amount_paid_minor - order.amount_refunded_minor
                    ),
                    now,
                );
            }
        }
        let previous = order.status;
        order.status = next;
        order.updated_at = now;
        orders.insert(id, order.clone());
        audit(
            Some(id),
            actor,
            "order.status_changed",
            format!("from={previous:?}; to={next:?}"),
            now,
        );
        Ok(order)
    })
}

pub fn cancel_customer_order(
    id: u64,
    customer: &CustomerIdentity,
    actor: &str,
    now: u64,
) -> Result<Order, OrderError> {
    let order = get_order(id).ok_or_else(|| OrderError::NotFound("order not found".to_string()))?;
    if &order.customer != customer {
        return Err(OrderError::NotFound("order not found".to_string()));
    }
    if !matches!(
        order.status,
        OrderStatus::Pending | OrderStatus::AwaitingPayment
    ) {
        return Err(OrderError::Conflict(
            "only pending orders can be cancelled by customers".to_string(),
        ));
    }
    update_order_status(id, OrderStatus::Cancelled, actor, now)
}

fn release_stock(order: &mut Order, now: u64) -> Result<(), OrderError> {
    if order.stock_released {
        return Ok(());
    }
    INVENTORY.with(|items| {
        let mut items = items.borrow_mut();
        for line in &order.items {
            let Some(mut item) = items.get(&line.inventory_id) else {
                continue;
            };
            if let Some(available) = item.stock_quantity {
                item.stock_quantity =
                    Some(available.checked_add(line.quantity).ok_or_else(|| {
                        OrderError::Internal("stock quantity overflow".to_string())
                    })?);
                item.updated_at = now;
                items.insert(item.id, item);
            }
        }
        Ok(())
    })?;
    order.stock_released = true;
    Ok(())
}

fn valid_transition(current: OrderStatus, next: OrderStatus) -> bool {
    use OrderStatus::*;
    matches!(
        (current, next),
        (AwaitingPayment, Pending | Cancelled | Expired)
            | (Pending, Confirmed | Cancelled)
            | (Confirmed, Preparing | Cancelled)
            | (Preparing, Ready | Cancelled)
            | (Ready, OutForDelivery | Completed | Cancelled)
            | (OutForDelivery, Completed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_valid_order_progressions_are_allowed() {
        assert!(valid_transition(
            OrderStatus::Pending,
            OrderStatus::Confirmed
        ));
        assert!(valid_transition(OrderStatus::Ready, OrderStatus::Completed));
        assert!(!valid_transition(
            OrderStatus::Completed,
            OrderStatus::Cancelled
        ));
        assert!(!valid_transition(
            OrderStatus::Pending,
            OrderStatus::Completed
        ));
    }
}
