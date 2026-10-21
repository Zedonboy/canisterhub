//! Stable storage: one `MemoryManager`-backed region per piece of state, so
//! it all survives a canister upgrade. Follows `connector/src/state.rs`'s
//! exact pattern (named `MemoryId`s, `thread_local!` cells, `ciborium` for
//! anything that isn't already `Storable`).

use crate::config::Config;
use crate::messages::{AdminRequest, ConversationState, AgentStats, SessionKey};
use crate::tools::CustomerProfile;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use std::borrow::Cow;
use std::cell::RefCell;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

/// One customer's conversation is trimmed to its last `MAX_HISTORY_MESSAGES`
/// entries (oldest dropped first) every time a new turn is appended - see
/// `ConversationState`'s doc comment for why only finished turns are kept at
/// all. 20 messages (10 user/assistant pairs) comfortably fits under the LLM
/// canister's own prompt-size limit (10KiB across all messages, per
/// https://github.com/dfinity/llm) for anything but unusually long messages,
/// while still giving the model several turns of real context.
pub const MAX_HISTORY_MESSAGES: usize = 20;

const CONFIG_MEM_ID: MemoryId = MemoryId::new(0);
const CONVERSATIONS_MEM_ID: MemoryId = MemoryId::new(1);
const ADMIN_REQUESTS_MEM_ID: MemoryId = MemoryId::new(2);
const ADMIN_REQUEST_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(3);
const CUSTOMER_PROFILES_MEM_ID: MemoryId = MemoryId::new(4);
const AGENT_STATS_MEM_ID: MemoryId = MemoryId::new(5);

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

// `SessionKey` isn't `serde::Serialize`/`Deserialize` (it isn't a candid
// type - see its doc comment for why it's kept out of any candid surface)
// so it gets its own tiny manual encoding instead of going through ciborium
// like everything else here: a `u8` channel tag followed by the session id
// bytes verbatim. Simple, and avoids deriving `serde` traits on a type
// that's deliberately not part of this canister's public interface.
impl SessionKey {
    fn encode(&self) -> Vec<u8> {
        let tag: u8 = match self.channel {
            crate::messages::Channel::WhatsApp => 0,
            crate::messages::Channel::Telegram => 1,
            crate::messages::Channel::Email => 2,
        };
        let mut buf = vec![tag];
        buf.extend_from_slice(self.session_id.as_bytes());
        buf
    }

    fn decode(bytes: &[u8]) -> Self {
        let (tag, rest) = bytes.split_first().expect("SessionKey bytes must be non-empty");
        let channel = match tag {
            0 => crate::messages::Channel::WhatsApp,
            1 => crate::messages::Channel::Telegram,
            2 => crate::messages::Channel::Email,
            other => panic!("unknown Channel tag {other} while decoding SessionKey"),
        };
        SessionKey { channel, session_id: String::from_utf8(rest.to_vec()).expect("SessionKey session_id must be valid UTF-8") }
    }
}

impl Storable for ConversationState {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode ConversationState");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode ConversationState")
    }
}

impl Storable for CustomerProfile {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode CustomerProfile");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode CustomerProfile")
    }
}

impl Storable for AgentStats {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode AgentStats");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode AgentStats")
    }
}

impl Storable for AdminRequest {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode AdminRequest");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode AdminRequest")
    }
}

/// Wraps `SessionKey` so `StableBTreeMap` can use its hand-rolled
/// `encode`/`decode` (above) instead of requiring `serde` derives on a
/// non-candid type.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SessionKeyStorable(SessionKey);

impl Storable for SessionKeyStorable {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.0.encode())
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0.encode()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        SessionKeyStorable(SessionKey::decode(bytes.as_ref()))
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONFIG_MEM_ID)), Config::default())
    );

    static CONVERSATIONS: RefCell<StableBTreeMap<SessionKeyStorable, ConversationState, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONVERSATIONS_MEM_ID)))
    );

    static ADMIN_REQUESTS: RefCell<StableBTreeMap<u64, AdminRequest, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ADMIN_REQUESTS_MEM_ID)))
    );
    static ADMIN_REQUEST_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(ADMIN_REQUEST_ID_COUNTER_MEM_ID)), 0)
    );

    static CUSTOMER_PROFILES: RefCell<StableBTreeMap<SessionKeyStorable, CustomerProfile, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(CUSTOMER_PROFILES_MEM_ID)))
    );

    static AGENT_STATS: RefCell<StableCell<AgentStats, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(AGENT_STATS_MEM_ID)), AgentStats::default())
    );
}

/// Every example tool in `tools.rs` keys a customer's own record by
/// `SessionKey` alone - see that module's doc comment for why, and for what
/// a real deployment with a separate account concept should do instead.
pub fn get_customer_profile(key: &SessionKey) -> CustomerProfile {
    CUSTOMER_PROFILES.with(|m| m.borrow().get(&SessionKeyStorable(key.clone())).unwrap_or_default())
}

pub fn set_customer_profile(key: &SessionKey, profile: CustomerProfile) {
    CUSTOMER_PROFILES.with(|m| m.borrow_mut().insert(SessionKeyStorable(key.clone()), profile));
}

pub fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn set_config(config: Config) {
    CONFIG.with(|c| c.borrow_mut().set(config));
}

pub fn get_conversation(key: &SessionKey) -> ConversationState {
    CONVERSATIONS.with(|c| c.borrow().get(&SessionKeyStorable(key.clone())).unwrap_or_default())
}

/// Appends one finished turn (a `User` message and its final `Assistant`
/// reply) and trims to `MAX_HISTORY_MESSAGES`.
pub fn append_turn(key: &SessionKey, mut conversation: ConversationState) {
    if conversation.history.len() > MAX_HISTORY_MESSAGES {
        let drop = conversation.history.len() - MAX_HISTORY_MESSAGES;
        conversation.history.drain(0..drop);
    }
    CONVERSATIONS.with(|c| c.borrow_mut().insert(SessionKeyStorable(key.clone()), conversation));
}

pub fn next_admin_request_id() -> u64 {
    ADMIN_REQUEST_ID_COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        let id = *c.get();
        c.set(id + 1);
        id
    })
}

pub fn insert_admin_request(req: AdminRequest) {
    ADMIN_REQUESTS.with(|m| m.borrow_mut().insert(req.id, req));
}

pub fn get_admin_request(id: u64) -> Option<AdminRequest> {
    ADMIN_REQUESTS.with(|m| m.borrow().get(&id))
}

pub fn update_admin_request(id: u64, f: impl FnOnce(&mut AdminRequest)) -> Result<(), String> {
    ADMIN_REQUESTS.with(|m| {
        let mut m = m.borrow_mut();
        let Some(mut req) = m.get(&id) else {
            return Err(format!("no admin request with id {id}"));
        };
        f(&mut req);
        m.insert(id, req);
        Ok(())
    })
}

pub fn list_admin_requests(offset: u64, limit: u64) -> Vec<AdminRequest> {
    ADMIN_REQUESTS.with(|m| {
        let m = m.borrow();
        let mut ids_desc: Vec<u64> = m.iter().map(|entry| *entry.key()).collect();
        ids_desc.reverse();
        ids_desc.into_iter().skip(offset as usize).take(limit as usize).filter_map(|id| m.get(&id)).collect()
    })
}

pub fn get_stats() -> AgentStats {
    AGENT_STATS.with(|s| *s.borrow().get())
}

/// Records one finished `receive_message` turn (one message in, one reply
/// out - see `AgentStats`'s doc comment for why they're always paired).
pub fn record_turn() {
    AGENT_STATS.with(|s| {
        let mut s = s.borrow_mut();
        let mut stats = *s.get();
        stats.messages_in += 1;
        stats.messages_out += 1;
        s.set(stats);
    });
}

/// Adds one completion call's token usage to the running total - called
/// from `llm.rs`'s `TrackingModel` regardless of whether the overall
/// `dispatch` call ultimately succeeded, since tokens already spent on a
/// completion request are spent whether or not a later step in the loop
/// fails.
pub fn record_usage(prompt_tokens: u64, completion_tokens: u64) {
    AGENT_STATS.with(|s| {
        let mut s = s.borrow_mut();
        let mut stats = *s.get();
        stats.prompt_tokens += prompt_tokens;
        stats.completion_tokens += completion_tokens;
        s.set(stats);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same caveat as `connector`'s equivalent test: this `thread_local!`
    // state is process-wide across `cargo test`'s threads, so this asserts
    // deltas rather than absolute values to stay correct under any test
    // execution order.
    #[test]
    fn record_turn_and_record_usage_accumulate_onto_get_stats() {
        let before = get_stats();
        record_turn();
        record_usage(120, 45);
        record_usage(30, 10);
        let after = get_stats();
        assert_eq!(after.messages_in, before.messages_in + 1);
        assert_eq!(after.messages_out, before.messages_out + 1);
        assert_eq!(after.prompt_tokens, before.prompt_tokens + 150);
        assert_eq!(after.completion_tokens, before.completion_tokens + 55);
    }
}
