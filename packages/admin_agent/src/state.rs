//! Stable storage: `Config`, plus an append-only audit log of every
//! privileged action taken (through either entry point - a direct candid
//! call or `chat`'s tool-calling loop; see `tools.rs`). Logging every
//! privileged action is a deliberate, non-optional part of this template -
//! see `lib.rs`'s doc comment.

use crate::config::Config;
use candid::{CandidType, Principal};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

const CONFIG_MEM_ID: MemoryId = MemoryId::new(0);
const ACTION_LOG_MEM_ID: MemoryId = MemoryId::new(1);
const ACTION_LOG_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(2);

/// One entry in the audit log - who did what, when. `action`/`details` are
/// free text (the tool/method name, and a human-readable summary of its
/// arguments) rather than a structured type, since what's worth recording
/// varies per action - see `tools.rs`'s example tools for the convention.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ActionLogEntry {
    pub id: u64,
    pub admin: Principal,
    pub action: String,
    pub details: String,
    pub at: u64,
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

impl Storable for ActionLogEntry {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode ActionLogEntry");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode ActionLogEntry")
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONFIG_MEM_ID)), Config::default())
    );

    static ACTION_LOG: RefCell<StableBTreeMap<u64, ActionLogEntry, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ACTION_LOG_MEM_ID)))
    );
    static ACTION_LOG_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(ACTION_LOG_ID_COUNTER_MEM_ID)), 0)
    );
}

pub fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn set_config(config: Config) {
    CONFIG.with(|c| c.borrow_mut().set(config));
}

/// Records one privileged action - called by every `tools.rs` impl
/// function, so both entry points (a direct candid call, or `chat`'s
/// tool-calling loop) are logged identically and automatically.
pub fn log_action(admin: Principal, action: &str, details: &str) {
    let id = ACTION_LOG_ID_COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        let id = *c.get();
        c.set(id + 1);
        id
    });
    let entry = ActionLogEntry {
        id,
        admin,
        action: action.to_string(),
        details: details.to_string(),
        at: ic_cdk::api::time(),
    };
    ACTION_LOG.with(|m| m.borrow_mut().insert(id, entry));
}

/// Newest-first, paginated.
pub fn list_action_log(offset: u64, limit: u64) -> Vec<ActionLogEntry> {
    ACTION_LOG.with(|m| {
        let m = m.borrow();
        let mut ids_desc: Vec<u64> = m.iter().map(|entry| *entry.key()).collect();
        ids_desc.reverse();
        ids_desc
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .filter_map(|id| m.get(&id))
            .collect()
    })
}
