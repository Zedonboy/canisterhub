//! Stable storage: one `MemoryManager`-backed region per piece of state, so
//! it all survives a canister upgrade. Follows `backend/src/lib.rs`'s exact
//! pattern (named `MemoryId`s, `thread_local!` cells, `ciborium` for anything
//! that isn't already `Storable`).

use crate::config::Config;
use crate::messages::StoredMessage;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use std::borrow::Cow;
use std::cell::RefCell;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

const MESSAGES_MEM_ID: MemoryId = MemoryId::new(0);
const MESSAGE_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(1);
const CONFIG_MEM_ID: MemoryId = MemoryId::new(2);

impl Storable for StoredMessage {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode StoredMessage");
        Cow::Owned(buf)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode StoredMessage")
    }
}

impl Storable for Config {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode Config");
        Cow::Owned(buf)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode Config")
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static MESSAGES: RefCell<StableBTreeMap<u64, StoredMessage, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(MESSAGES_MEM_ID)))
    );

    static MESSAGE_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(MESSAGE_ID_COUNTER_MEM_ID)), 0)
    );

    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONFIG_MEM_ID)), Config::default())
    );
}

pub fn next_message_id() -> u64 {
    MESSAGE_ID_COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        let id = *c.get();
        c.set(id + 1);
        id
    })
}

/// How many messages this canister has ever stored (WhatsApp + Telegram +
/// mail combined) - the counter `next_message_id` hands out ids from, read
/// without advancing it. This *is* "messages processed": every inbound
/// message that reaches `store` gets an id from this same counter, so its
/// current value is exactly that running total - no separate counter to
/// keep in sync.
pub fn message_count() -> u64 {
    MESSAGE_ID_COUNTER.with(|c| *c.borrow().get())
}

pub fn insert_message(msg: StoredMessage) {
    MESSAGES.with(|m| m.borrow_mut().insert(msg.id, msg));
}

pub fn get_message(id: u64) -> Option<StoredMessage> {
    MESSAGES.with(|m| m.borrow().get(&id))
}

/// Returns up to `limit` messages starting at `offset`, newest-first (highest
/// id first) - a simple recency-ordered feed rather than exposing
/// `StableBTreeMap`'s own ascending-key iteration order. `ids_desc` is a
/// small allocation (one `u64` per stored message); fine at the scale this
/// canister's message volume is expected to stay at, but worth revisiting
/// with a reverse-ordered index if that changes.
pub fn list_messages(offset: u64, limit: u64) -> Vec<StoredMessage> {
    MESSAGES.with(|m| {
        let m = m.borrow();
        let mut ids_desc: Vec<u64> = m.iter().map(|entry| *entry.key()).collect();
        ids_desc.reverse();
        ids_desc.into_iter().skip(offset as usize).take(limit as usize).filter_map(|id| m.get(&id)).collect()
    })
}

pub fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn set_config(config: Config) {
    CONFIG.with(|c| c.borrow_mut().set(config));
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shares one process-wide `thread_local!` memory manager with every
    // other test in this file (and, since Rust runs `cargo test` in one
    // process with tests on separate threads, potentially with a test in
    // another module too, if one ever touches this same state) - so this
    // asserts the counter only ever *advances*, never a specific absolute
    // value, to stay correct regardless of test execution order.
    #[test]
    fn message_count_reflects_next_message_id_without_advancing_it() {
        let before = message_count();
        let issued = next_message_id();
        assert_eq!(issued, before, "next_message_id should hand out exactly the value message_count last reported");
        assert_eq!(message_count(), before + 1, "message_count should reflect the id just issued");
        // Reading it again doesn't advance it further.
        assert_eq!(message_count(), before + 1);
    }
}
