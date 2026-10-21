use crate::{ApiError, CreateItem, Item};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use std::{borrow::Cow, cell::RefCell};

type Memory = VirtualMemory<DefaultMemoryImpl>;

const ITEMS_MEMORY_ID: MemoryId = MemoryId::new(0);
const NEXT_ID_MEMORY_ID: MemoryId = MemoryId::new(1);
const MAX_ITEMS_PER_PROFILE: usize = 100;
const MAX_STORED_ITEM_BYTES: u32 = 12 * 1024;

impl Storable for Item {
    const BOUND: Bound = Bound::Bounded {
        max_size: MAX_STORED_ITEM_BYTES,
        is_fixed_size: false,
    };

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes).expect("failed to encode Item");
        Cow::Owned(bytes)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode Item")
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static ITEMS: RefCell<StableBTreeMap<u64, Item, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|manager| manager.borrow().get(ITEMS_MEMORY_ID)))
    );
    static NEXT_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|manager| manager.borrow().get(NEXT_ID_MEMORY_ID)), 0)
    );
}

pub fn create(profile_id: u64, input: CreateItem, now: u64) -> Result<Item, ApiError> {
    let count = ITEMS.with(|items| {
        items
            .borrow()
            .iter()
            .filter(|entry| entry.value().owner_profile_id == profile_id)
            .count()
    });
    if count >= MAX_ITEMS_PER_PROFILE {
        return Err(ApiError::Conflict(format!(
            "a profile may store at most {MAX_ITEMS_PER_PROFILE} items"
        )));
    }

    let id = NEXT_ID.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        let next = id
            .checked_add(1)
            .ok_or_else(|| ApiError::Internal("item id space exhausted".to_string()))?;
        counter.set(next);
        Ok(id)
    })?;

    let item = Item {
        id,
        owner_profile_id: profile_id,
        name: input.name,
        payload: input.payload,
        created_at: now,
        updated_at: now,
    };
    ITEMS.with(|items| items.borrow_mut().insert(id, item.clone()));
    Ok(item)
}

pub fn list(profile_id: u64) -> Vec<Item> {
    ITEMS.with(|items| {
        items
            .borrow()
            .iter()
            .filter_map(|entry| {
                let item = entry.value();
                (item.owner_profile_id == profile_id).then_some(item)
            })
            .collect()
    })
}

pub fn delete(profile_id: u64, id: u64) -> Result<Item, ApiError> {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let item = items.get(&id).ok_or(ApiError::NotFound)?;
        if item.owner_profile_id != profile_id {
            return Err(ApiError::NotFound);
        }
        items.remove(&id).ok_or(ApiError::NotFound)
    })
}
