//! Stable storage: one `MemoryManager`-backed region per piece of state, so
//! it all survives a canister upgrade. Follows `connector/src/state.rs`'s
//! exact pattern (named `MemoryId`s, `thread_local!` cells, `ciborium` for
//! anything that isn't already `Storable`) - `String`/`Vec<u8>`/`u64` all
//! have native `Storable` impls in `ic-stable-structures`, so the three
//! lookup indices below (principal -> id, "provider:subject" -> id, session
//! token -> record) need no wrapper types of their own, unlike
//! `agent::state`'s `SessionKeyStorable`.

use crate::config::{Config, RuntimeConfig};
use crate::messages::Profile;
use candid::Principal;
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
const PROFILES_MEM_ID: MemoryId = MemoryId::new(1);
const PROFILE_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(2);
const PRINCIPAL_INDEX_MEM_ID: MemoryId = MemoryId::new(3);
const OAUTH_INDEX_MEM_ID: MemoryId = MemoryId::new(4);
const SESSIONS_MEM_ID: MemoryId = MemoryId::new(5);
const PENDING_STATES_MEM_ID: MemoryId = MemoryId::new(6);
const DYNAMIC_CONFIG_MEM_ID: MemoryId = MemoryId::new(7);
const DYNAMIC_CONFIG_MIGRATED_MEM_ID: MemoryId = MemoryId::new(8);

/// One session issued when an OAuth login completes (see
/// `lib.rs::handle_oauth_callback`) - the session-token half of this
/// crate's two-path auth design (see its module doc comment). Looked up by
/// the random token itself (the `SESSIONS` map's key), so this record
/// doesn't need to repeat it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRecord {
    pub profile_id: u64,
    pub expires_at: u64,
}

/// A CSRF token issued by `begin_oauth` and round-tripped through the
/// provider's own redirect - `handle_oauth_callback` rejects a callback
/// naming a `state` that isn't in this map (or has expired), the same way
/// any OAuth2 client must reject a callback it didn't itself initiate.
/// `linking_principal`, if set, means this flow was started by an
/// already-authenticated caller wanting to *link* a new provider to their
/// existing profile (`link_current_principal`'s counterpart on the
/// initiating side) rather than sign in fresh.
#[derive(Clone, Debug)]
pub struct PendingOAuthState {
    pub provider: String,
    pub linking_principal: Option<Principal>,
    pub created_at: u64,
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

impl Storable for Profile {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("failed to encode Profile");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("failed to decode Profile")
    }
}

// `SessionRecord`/`PendingOAuthState` aren't candid types (no reason for
// either to ever cross this canister's own interface - see their doc
// comments), so they get plain `serde` derives instead of `CandidType`,
// same reasoning as `agent::messages::SessionKey` staying out of
// its own candid surface.
#[derive(Serialize, Deserialize)]
struct SessionRecordRepr {
    profile_id: u64,
    expires_at: u64,
}
#[derive(Serialize, Deserialize)]
struct PendingOAuthStateRepr {
    provider: String,
    linking_principal: Option<Vec<u8>>,
    created_at: u64,
}

impl Storable for SessionRecord {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(
            &SessionRecordRepr {
                profile_id: self.profile_id,
                expires_at: self.expires_at,
            },
            &mut buf,
        )
        .expect("failed to encode SessionRecord");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let repr: SessionRecordRepr =
            ciborium::from_reader(bytes.as_ref()).expect("failed to decode SessionRecord");
        SessionRecord {
            profile_id: repr.profile_id,
            expires_at: repr.expires_at,
        }
    }
}

impl Storable for PendingOAuthState {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        let repr = PendingOAuthStateRepr {
            provider: self.provider.clone(),
            linking_principal: self.linking_principal.map(|p| p.as_slice().to_vec()),
            created_at: self.created_at,
        };
        ciborium::into_writer(&repr, &mut buf).expect("failed to encode PendingOAuthState");
        Cow::Owned(buf)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let repr: PendingOAuthStateRepr =
            ciborium::from_reader(bytes.as_ref()).expect("failed to decode PendingOAuthState");
        PendingOAuthState {
            provider: repr.provider,
            linking_principal: repr.linking_principal.map(|b| Principal::from_slice(&b)),
            created_at: repr.created_at,
        }
    }
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONFIG_MEM_ID)), Config::default())
    );

    static PROFILES: RefCell<StableBTreeMap<u64, Profile, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROFILES_MEM_ID)))
    );
    static PROFILE_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROFILE_ID_COUNTER_MEM_ID)), 0)
    );

    /// Principal (raw bytes, via `Principal::as_slice`) -> profile id.
    static PRINCIPAL_INDEX: RefCell<StableBTreeMap<Vec<u8>, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PRINCIPAL_INDEX_MEM_ID)))
    );
    /// `"{provider}:{subject}"` -> profile id.
    static OAUTH_INDEX: RefCell<StableBTreeMap<String, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(OAUTH_INDEX_MEM_ID)))
    );
    /// Session token -> record.
    static SESSIONS: RefCell<StableBTreeMap<String, SessionRecord, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(SESSIONS_MEM_ID)))
    );
    /// CSRF `state` token -> what it's for.
    static PENDING_STATES: RefCell<StableBTreeMap<String, PendingOAuthState, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PENDING_STATES_MEM_ID)))
    );
}

pub fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn set_config(config: Config) {
    CONFIG.with(|c| c.borrow_mut().set(config));
}

/// Opens the runtime-config store and imports the scalar values from the
/// legacy all-in-one config cell once. OAuth providers and trusted canisters
/// continue to live in that cell and are managed by their dedicated APIs.
pub fn init_dynamic_config_store() {
    canister_hub_sdk::ic::config::init_stable_store::<RuntimeConfig>(
        MEMORY_MANAGER.with(|manager| manager.borrow().get(DYNAMIC_CONFIG_MEM_ID)),
    );

    let mut migrated = StableCell::init(
        MEMORY_MANAGER.with(|manager| manager.borrow().get(DYNAMIC_CONFIG_MIGRATED_MEM_ID)),
        false,
    );
    if !*migrated.get() {
        let legacy = get_config();
        let mut settings = std::collections::HashMap::new();
        if legacy.session_ttl_secs > 0 {
            let ttl = i64::try_from(legacy.session_ttl_secs)
                .expect("legacy session TTL exceeds the dynamic config number range");
            settings.insert(
                "session_ttl_secs".to_owned(),
                canister_hub_sdk::ic::config::ConfigValue::Number(ttl),
            );
        }
        if let Some(url) = legacy.frontend_redirect_url {
            settings.insert(
                "frontend_redirect_url".to_owned(),
                canister_hub_sdk::ic::config::ConfigValue::Text(url),
            );
        }
        if !settings.is_empty() {
            canister_hub_sdk::ic::config::set::<RuntimeConfig>(settings)
                .expect("legacy auth config must satisfy the dynamic schema");
        }
        migrated.set(true);
    }
}

fn oauth_key(provider: &str, subject: &str) -> String {
    format!("{provider}:{subject}")
}

pub fn get_profile(id: u64) -> Option<Profile> {
    PROFILES.with(|p| p.borrow().get(&id))
}

pub fn get_profile_by_principal(principal: &Principal) -> Option<Profile> {
    let id = PRINCIPAL_INDEX.with(|idx| idx.borrow().get(&principal.as_slice().to_vec()))?;
    get_profile(id)
}

pub fn get_profile_by_oauth(provider: &str, subject: &str) -> Option<Profile> {
    let id = OAUTH_INDEX.with(|idx| idx.borrow().get(&oauth_key(provider, subject)))?;
    get_profile(id)
}

/// Newest-first, paginated - matches every other building block's own
/// `list_*` convention (see e.g. `connector::list_messages`).
pub fn list_profiles(offset: u64, limit: u64) -> Vec<Profile> {
    PROFILES.with(|p| {
        let p = p.borrow();
        let mut ids_desc: Vec<u64> = p.iter().map(|entry| *entry.key()).collect();
        ids_desc.reverse();
        ids_desc
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .filter_map(|id| p.get(&id))
            .collect()
    })
}

fn next_profile_id() -> u64 {
    PROFILE_ID_COUNTER.with(|c| {
        let mut c = c.borrow_mut();
        let id = *c.get();
        c.set(id + 1);
        id
    })
}

pub fn insert_profile(profile: Profile) {
    if let Some(principal) = profile.principal {
        PRINCIPAL_INDEX.with(|idx| {
            idx.borrow_mut()
                .insert(principal.as_slice().to_vec(), profile.id)
        });
    }
    for link in &profile.oauth_links {
        OAUTH_INDEX.with(|idx| {
            idx.borrow_mut()
                .insert(oauth_key(&link.provider, &link.subject), profile.id)
        });
    }
    PROFILES.with(|p| p.borrow_mut().insert(profile.id, profile));
}

/// Creates a brand-new profile with the next id, linked to nothing yet -
/// callers set `principal`/`oauth_links` afterward and call `insert_profile`
/// (or, for the common "just got an OAuth login" case, use
/// `create_profile_with_oauth_link` instead).
pub fn new_profile_id() -> u64 {
    next_profile_id()
}

pub fn create_session(token: String, profile_id: u64, expires_at: u64) {
    SESSIONS.with(|s| {
        s.borrow_mut().insert(
            token,
            SessionRecord {
                profile_id,
                expires_at,
            },
        )
    });
}

/// `None` if the token doesn't exist *or* has expired - a caller has no
/// legitimate reason to distinguish the two, and treating an expired
/// session as simply absent avoids leaking timing/existence information
/// either way.
pub fn get_session(token: &str, now: u64) -> Option<SessionRecord> {
    let record = SESSIONS.with(|s| s.borrow().get(&token.to_string()))?;
    if record.expires_at <= now {
        return None;
    }
    Some(record)
}

pub fn insert_pending_state(token: String, state: PendingOAuthState) {
    PENDING_STATES.with(|s| s.borrow_mut().insert(token, state));
}

/// Removes and returns the pending state for `token`, if any - always
/// consumed on lookup (a `state` token is single-use, same as an OAuth
/// authorization `code` itself), so a replayed callback with the same
/// `state` finds nothing the second time.
pub fn take_pending_state(token: &str) -> Option<PendingOAuthState> {
    PENDING_STATES.with(|s| s.borrow_mut().remove(&token.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::OAuthLink;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    fn profile(id: u64) -> Profile {
        Profile {
            id,
            principal: None,
            display_name: None,
            email: None,
            avatar_url: None,
            oauth_links: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn insert_and_get_profile_round_trips() {
        let id = new_profile_id();
        insert_profile(profile(id));
        assert_eq!(get_profile(id).map(|p| p.id), Some(id));
    }

    #[test]
    fn get_profile_by_principal_finds_a_linked_profile() {
        let id = new_profile_id();
        let p = principal(200);
        insert_profile(Profile {
            principal: Some(p),
            ..profile(id)
        });
        assert_eq!(get_profile_by_principal(&p).map(|pr| pr.id), Some(id));
        assert_eq!(get_profile_by_principal(&principal(201)), None);
    }

    #[test]
    fn get_profile_by_oauth_finds_a_linked_profile() {
        let id = new_profile_id();
        let link = OAuthLink {
            provider: "google".to_string(),
            subject: "sub-1".to_string(),
            email: None,
            linked_at: 0,
        };
        insert_profile(Profile {
            oauth_links: vec![link],
            ..profile(id)
        });
        assert_eq!(
            get_profile_by_oauth("google", "sub-1").map(|p| p.id),
            Some(id)
        );
        assert_eq!(get_profile_by_oauth("google", "sub-2"), None);
        assert_eq!(
            get_profile_by_oauth("github", "sub-1"),
            None,
            "index is keyed by (provider, subject), not subject alone"
        );
    }

    #[test]
    fn session_expires_after_its_own_expiry_time() {
        let token = "tok-1".to_string();
        create_session(token.clone(), 42, 1000);
        assert_eq!(get_session(&token, 999).map(|s| s.profile_id), Some(42));
        assert_eq!(
            get_session(&token, 1000),
            None,
            "expires_at is exclusive - now == expires_at means expired"
        );
        assert_eq!(get_session(&token, 1001), None);
    }

    #[test]
    fn pending_state_is_consumed_on_first_lookup() {
        let token = "state-1".to_string();
        insert_pending_state(
            token.clone(),
            PendingOAuthState {
                provider: "google".to_string(),
                linking_principal: None,
                created_at: 0,
            },
        );
        assert!(take_pending_state(&token).is_some());
        assert!(
            take_pending_state(&token).is_none(),
            "a state token is single-use"
        );
    }
}
