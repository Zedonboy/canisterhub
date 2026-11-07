use crate::types::*;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use std::{borrow::Cow, cell::RefCell};

type Memory = VirtualMemory<DefaultMemoryImpl>;
const MENU_MEMORY_ID: MemoryId = MemoryId::new(0);
const ORDERS_MEMORY_ID: MemoryId = MemoryId::new(1);
const MENU_ID_MEMORY_ID: MemoryId = MemoryId::new(2);
const ORDER_ID_MEMORY_ID: MemoryId = MemoryId::new(3);
// Memory id 4 was used by the removed AI staff allowlist. Keep ids stable.
const DYNAMIC_CONFIG_MEMORY_ID: MemoryId = MemoryId::new(5);

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

stable_cbor!(MenuItem);
stable_cbor!(RestaurantOrder);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> = RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static MENU: RefCell<StableBTreeMap<u64, MenuItem, Memory>> = RefCell::new(StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(MENU_MEMORY_ID))));
    static ORDERS: RefCell<StableBTreeMap<u64, RestaurantOrder, Memory>> = RefCell::new(StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ORDERS_MEMORY_ID))));
    static NEXT_MENU_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(MENU_ID_MEMORY_ID)), 1));
    static NEXT_ORDER_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(ORDER_ID_MEMORY_ID)), 1));
}

pub fn dynamic_config_memory() -> Memory {
    MEMORY_MANAGER.with(|manager| manager.borrow().get(DYNAMIC_CONFIG_MEMORY_ID))
}

fn take_id(
    cell: &'static std::thread::LocalKey<RefCell<StableCell<u64, Memory>>>,
) -> Result<u64, String> {
    cell.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        let next = id.checked_add(1).ok_or("id space exhausted")?;
        counter.set(next);
        Ok(id)
    })
}

pub fn create_menu(input: CreateMenuItem, now: u64) -> Result<MenuItem, String> {
    let id = take_id(&NEXT_MENU_ID)?;
    let item = MenuItem {
        id,
        name: input.name,
        description: input.description,
        price_per_portion_minor: input.price_per_portion_minor,
        plate_price_minor: input.plate_price_minor,
        image_url: input.image_url,
        currency: input.currency.to_ascii_uppercase(),
        payment_method: input.payment_method,
        available: input.available,
        created_at: now,
        updated_at: now,
    };
    MENU.with(|menu| {
        menu.borrow_mut().insert(id, item.clone());
    });
    Ok(item)
}

pub fn update_menu(id: u64, update: UpdateMenuItem, now: u64) -> Result<MenuItem, String> {
    MENU.with(|menu| {
        let mut menu = menu.borrow_mut();
        let mut item = menu.get(&id).ok_or("menu item not found")?;
        if let Some(value) = update.name {
            item.name = value;
        }
        if let Some(value) = update.description {
            item.description = value;
        }
        if let Some(value) = update.price_per_portion_minor {
            item.price_per_portion_minor = value;
        }
        if let Some(value) = update.plate_price_minor {
            item.plate_price_minor = value;
        }
        if let Some(value) = update.image_url {
            item.image_url = (!value.is_empty()).then_some(value);
        }
        if let Some(value) = update.currency {
            item.currency = value.to_ascii_uppercase();
        }
        if let Some(value) = update.payment_method {
            item.payment_method = value;
        }
        if let Some(value) = update.available {
            item.available = value;
        }
        item.updated_at = now;
        menu.insert(id, item.clone());
        Ok(item)
    })
}

pub fn get_menu(id: u64) -> Option<MenuItem> {
    MENU.with(|menu| menu.borrow().get(&id))
}

pub fn list_menu(active_only: bool) -> Vec<MenuItem> {
    MENU.with(|menu| {
        menu.borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|item| !active_only || item.available)
            .collect()
    })
}

pub fn create_order(mut order: RestaurantOrder) -> Result<RestaurantOrder, String> {
    let id = take_id(&NEXT_ORDER_ID)?;
    order.id = id;
    ORDERS.with(|orders| {
        orders.borrow_mut().insert(id, order.clone());
    });
    Ok(order)
}

pub fn update_order(order: RestaurantOrder) {
    ORDERS.with(|orders| {
        orders.borrow_mut().insert(order.id, order);
    });
}
pub fn get_order(id: u64) -> Option<RestaurantOrder> {
    ORDERS.with(|orders| orders.borrow().get(&id))
}
pub fn list_orders(status: Option<RestaurantOrderStatus>) -> Vec<RestaurantOrder> {
    ORDERS.with(|orders| {
        orders
            .borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|order| status.is_none_or(|status| order.status == status))
            .collect()
    })
}
pub fn list_customer_orders(customer: &CustomerIdentity) -> Vec<RestaurantOrder> {
    let mut orders = ORDERS.with(|orders| {
        orders
            .borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|order| &order.customer == customer)
            .collect::<Vec<_>>()
    });
    orders.sort_by_key(|order| order.created_at);
    orders
}
