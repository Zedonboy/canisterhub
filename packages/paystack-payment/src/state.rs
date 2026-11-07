use crate::ChargeRecord;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, Storable,
};
use std::{borrow::Cow, cell::RefCell};

type Memory = VirtualMemory<DefaultMemoryImpl>;
const CONFIG_MEMORY_ID: MemoryId = MemoryId::new(0);
const CHARGES_MEMORY_ID: MemoryId = MemoryId::new(1);

impl Storable for ChargeRecord {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes).expect("failed to encode charge record");
        Cow::Owned(bytes)
    }
    fn into_bytes(self) -> Vec<u8> { self.to_bytes().into_owned() }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode charge record")
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> = RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static CHARGES: RefCell<StableBTreeMap<String, ChargeRecord, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|manager| manager.borrow().get(CHARGES_MEMORY_ID)))
    );
}

pub fn init_config() {
    canister_hub_sdk::ic::config::init_stable_store::<crate::config::Config>(
        MEMORY_MANAGER.with(|manager| manager.borrow().get(CONFIG_MEMORY_ID)),
    );
}

pub fn save_charge(record: ChargeRecord) {
    CHARGES.with(|charges| charges.borrow_mut().insert(record.reference.clone(), record));
}

pub fn get_charge(reference: &str) -> Option<ChargeRecord> {
    CHARGES.with(|charges| charges.borrow().get(&reference.to_string()))
}

pub fn charge_count() -> usize {
    CHARGES.with(|charges| usize::try_from(charges.borrow().len()).unwrap_or(usize::MAX))
}

/// Every stored charge, in key order - the transaction-log endpoint sorts
/// for presentation (see `lib.rs::list_transactions`).
pub fn list_charges() -> Vec<ChargeRecord> {
    CHARGES.with(|charges| charges.borrow().iter().map(|entry| entry.value()).collect())
}

/// Mutates one stored charge in place; a no-op for unknown references.
pub fn update_charge(reference: &str, update: impl FnOnce(&mut ChargeRecord)) {
    CHARGES.with(|charges| {
        let mut charges = charges.borrow_mut();
        if let Some(mut charge) = charges.get(&reference.to_string()) {
            update(&mut charge);
            charges.insert(reference.to_string(), charge);
        }
    });
}

pub fn mark_owner_notified(reference: &str) {
    update_charge(reference, |charge| charge.owner_notified = true);
}
