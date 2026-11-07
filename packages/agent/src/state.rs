//! Stable storage: one `MemoryManager`-backed region per piece of state, so
//! it all survives a canister upgrade. Follows `connector/src/state.rs`'s
//! exact pattern (named `MemoryId`s, `thread_local!` cells, `ciborium` for
//! anything that isn't already `Storable`).

use crate::config::Config;
use crate::messages::{
    AdminRequest, AgentStats, AiCanister, Channel, ClientDataKind, ClientDataRequest,
    ClientDataValue, ConversationState, ConversationSummary, SessionKey, StoredChatMessage,
    StoredMessage, CONSOLE_SESSION,
};
use crate::tools::CustomerProfile;
use candid::Principal;
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
const MESSAGES_MEM_ID: MemoryId = MemoryId::new(6);
const MESSAGE_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(7);
const AI_CANISTERS_MEM_ID: MemoryId = MemoryId::new(8);
const CLIENT_DATA_REQUESTS_MEM_ID: MemoryId = MemoryId::new(9);
const CLIENT_DATA_REQUEST_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(10);

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
            crate::messages::Channel::Web => 3,
        };
        let mut buf = vec![tag];
        buf.extend_from_slice(self.session_id.as_bytes());
        buf
    }

    fn decode(bytes: &[u8]) -> Self {
        let (tag, rest) = bytes
            .split_first()
            .expect("SessionKey bytes must be non-empty");
        let channel = match tag {
            0 => crate::messages::Channel::WhatsApp,
            1 => crate::messages::Channel::Telegram,
            2 => crate::messages::Channel::Email,
            3 => crate::messages::Channel::Web,
            other => panic!("unknown Channel tag {other} while decoding SessionKey"),
        };
        SessionKey {
            channel,
            session_id: String::from_utf8(rest.to_vec())
                .expect("SessionKey session_id must be valid UTF-8"),
        }
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

macro_rules! impl_cbor_storable {
    ($ty:ty, $label:literal) => {
        impl Storable for $ty {
            const BOUND: Bound = Bound::Unbounded;
            fn to_bytes(&self) -> Cow<'_, [u8]> {
                let mut buf = vec![];
                ciborium::into_writer(self, &mut buf).expect(concat!("failed to encode ", $label));
                Cow::Owned(buf)
            }
            fn into_bytes(self) -> Vec<u8> {
                self.to_bytes().into_owned()
            }
            fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
                ciborium::from_reader(bytes.as_ref()).expect(concat!("failed to decode ", $label))
            }
        }
    };
}

impl_cbor_storable!(StoredMessage, "StoredMessage");
impl_cbor_storable!(AiCanister, "AiCanister");
impl_cbor_storable!(ClientDataRequest, "ClientDataRequest");

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

    static MESSAGES: RefCell<StableBTreeMap<u64, StoredMessage, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(MESSAGES_MEM_ID)))
    );
    static MESSAGE_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(MESSAGE_ID_COUNTER_MEM_ID)), 0)
    );
    static AI_CANISTERS: RefCell<StableBTreeMap<Vec<u8>, AiCanister, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(AI_CANISTERS_MEM_ID)))
    );
    static CLIENT_DATA_REQUESTS: RefCell<StableBTreeMap<SessionKeyStorable, ClientDataRequest, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(CLIENT_DATA_REQUESTS_MEM_ID)))
    );
    static CLIENT_DATA_REQUEST_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CLIENT_DATA_REQUEST_ID_COUNTER_MEM_ID)), 0)
    );
}

pub fn create_client_data_request(
    key: &SessionKey,
    kind: ClientDataKind,
    prompt: String,
) -> ClientDataRequest {
    let id = CLIENT_DATA_REQUEST_ID_COUNTER.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        counter.set(id.saturating_add(1));
        id
    });
    let request = ClientDataRequest {
        id,
        kind,
        prompt,
        created_at: ic_cdk::api::time(),
    };
    CLIENT_DATA_REQUESTS.with(|requests| {
        requests
            .borrow_mut()
            .insert(SessionKeyStorable(key.clone()), request.clone())
    });
    request
}

pub fn get_client_data_request(key: &SessionKey) -> Option<ClientDataRequest> {
    CLIENT_DATA_REQUESTS.with(|requests| requests.borrow().get(&SessionKeyStorable(key.clone())))
}

pub fn consume_client_data(
    key: &SessionKey,
    request_id: Option<u64>,
    value: &ClientDataValue,
) -> Result<(ClientDataRequest, String), String> {
    let request = get_client_data_request(key)
        .ok_or_else(|| "there is no pending client data request".to_string())?;
    if request_id.is_some_and(|id| id != request.id) {
        return Err("this client data request is no longer active".to_string());
    }
    value.validate_for(request.kind)?;
    CLIENT_DATA_REQUESTS.with(|requests| {
        requests
            .borrow_mut()
            .remove(&SessionKeyStorable(key.clone()))
    });
    let text = value.as_prompt_text(request.kind);
    Ok((request, text))
}

/// A normal typed reply completes any non-location request. Location remains
/// pending until the channel supplies actual coordinates, avoiding accidental
/// acceptance of an unrelated message as a location.
pub fn consume_typed_client_data(key: &SessionKey, text: &str) -> Option<ClientDataRequest> {
    let request = get_client_data_request(key)?;
    if request.kind == ClientDataKind::Location || text.trim().is_empty() {
        return None;
    }
    CLIENT_DATA_REQUESTS.with(|requests| {
        requests
            .borrow_mut()
            .remove(&SessionKeyStorable(key.clone()))
    });
    Some(request)
}

pub fn insert_message(payload: crate::messages::MessagePayload) -> StoredMessage {
    let id = MESSAGE_ID_COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        let id = *c.get();
        c.set(id + 1);
        id
    });
    let message = StoredMessage {
        id,
        received_at: ic_cdk::api::time(),
        payload,
    };
    MESSAGES.with(|m| m.borrow_mut().insert(id, message.clone()));
    message
}

pub fn get_message(id: u64) -> Option<StoredMessage> {
    MESSAGES.with(|m| m.borrow().get(&id))
}

pub fn list_messages(offset: u64, limit: u64) -> Vec<StoredMessage> {
    MESSAGES.with(|m| {
        let m = m.borrow();
        let mut ids: Vec<u64> = m.iter().map(|e| *e.key()).collect();
        ids.reverse();
        ids.into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .filter_map(|id| m.get(&id))
            .collect()
    })
}

pub fn message_count() -> u64 {
    MESSAGE_ID_COUNTER.with(|c| *c.borrow().get())
}

pub fn set_ai_canister(canister: AiCanister) {
    AI_CANISTERS.with(|m| {
        m.borrow_mut()
            .insert(canister.canister_id.as_slice().to_vec(), canister)
    });
}

pub fn remove_ai_canister(id: Principal) -> Option<AiCanister> {
    AI_CANISTERS.with(|m| m.borrow_mut().remove(&id.as_slice().to_vec()))
}

pub fn list_ai_canisters() -> Vec<AiCanister> {
    AI_CANISTERS.with(|m| m.borrow().iter().map(|entry| entry.value()).collect())
}

/// Every example tool in `tools.rs` keys a customer's own record by
/// `SessionKey` alone - see that module's doc comment for why, and for what
/// a real deployment with a separate account concept should do instead.
pub fn get_customer_profile(key: &SessionKey) -> CustomerProfile {
    CUSTOMER_PROFILES.with(|m| {
        m.borrow()
            .get(&SessionKeyStorable(key.clone()))
            .unwrap_or_default()
    })
}

pub fn set_customer_profile(key: &SessionKey, profile: CustomerProfile) {
    CUSTOMER_PROFILES.with(|m| {
        m.borrow_mut()
            .insert(SessionKeyStorable(key.clone()), profile)
    });
}

pub fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn set_config(config: Config) {
    CONFIG.with(|c| c.borrow_mut().set(config));
}

pub fn get_conversation(key: &SessionKey) -> ConversationState {
    CONVERSATIONS.with(|c| {
        c.borrow()
            .get(&SessionKeyStorable(key.clone()))
            .unwrap_or_default()
    })
}

/// Resolves a session ID to its channel for trusted business-package
/// messages. Session IDs are only channel-unique by convention, so fail
/// closed if stored conversations contain the same ID on multiple channels.
pub fn resolve_channel_for_session(session_id: &str) -> Result<Channel, String> {
    let mut resolved = None;
    CONVERSATIONS
        .with(|conversations| {
            for entry in conversations.borrow().iter() {
                let key = entry.key().0.clone();
                if key.session_id != session_id
                    || (key.channel == Channel::Web && key.session_id == CONSOLE_SESSION)
                {
                    continue;
                }
                match resolved {
                    Some(channel) if channel != key.channel => return Err(()),
                    Some(_) => {}
                    None => resolved = Some(key.channel),
                }
            }
            Ok(())
        })
        .map_err(|()| "session id matches more than one channel".to_string())?;
    resolved.ok_or_else(|| "session id is not associated with a conversation".to_string())
}

/// Appends one finished turn (a `User` message and its final `Assistant`
/// reply) and trims to `MAX_HISTORY_MESSAGES`.
pub fn append_turn(key: &SessionKey, mut conversation: ConversationState) {
    if conversation.history.len() > MAX_HISTORY_MESSAGES {
        let drop = conversation.history.len() - MAX_HISTORY_MESSAGES;
        conversation.history.drain(0..drop);
    }
    CONVERSATIONS.with(|c| {
        c.borrow_mut()
            .insert(SessionKeyStorable(key.clone()), conversation)
    });
}

/// Appends turns to one conversation under a single read-modify-write (no
/// `await` in between), so a human reply landing while the model is still
/// thinking is never overwritten.
pub fn append_messages(key: &SessionKey, messages: Vec<StoredChatMessage>) {
    let mut conversation = get_conversation(key);
    conversation.history.extend(messages);
    append_turn(key, conversation);
}

/// The SME inbox: every non-empty conversation except the private console,
/// newest activity first. Scans all conversations (a small SME's worth), so
/// `limit` only bounds the response.
pub fn list_conversation_summaries(offset: u64, limit: u64) -> Vec<ConversationSummary> {
    let mut all: Vec<ConversationSummary> = CONVERSATIONS.with(|c| {
        c.borrow()
            .iter()
            .filter_map(|entry| {
                let key = entry.key().0.clone();
                if key.channel == Channel::Web && key.session_id == CONSOLE_SESSION {
                    return None;
                }
                let history = entry.value().history;
                let last = history.last()?;
                let display_name = CUSTOMER_PROFILES.with(|m| {
                    m.borrow()
                        .get(&SessionKeyStorable(key.clone()))
                        .and_then(|p| p.display_name.or(p.username))
                });
                Some(ConversationSummary {
                    channel: key.channel,
                    session_id: key.session_id,
                    display_name,
                    last_text: last.content.chars().take(160).collect(),
                    last_role: last.role,
                    last_at: last.at,
                    message_count: history.len() as u64,
                })
            })
            .collect()
    });
    all.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    all.into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect()
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
        ids_desc
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .filter_map(|id| m.get(&id))
            .collect()
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
