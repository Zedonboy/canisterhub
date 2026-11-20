use super::VapidConfig;
use crate::{Memory, PushSubscription, MEMORY_MANAGER};
use candid::Principal;
use ic_stable_structures::{storable::Bound, StableBTreeMap, StableCell, Storable};
use std::{borrow::Cow, cell::RefCell};

const SUBSCRIPTIONS_MEMORY_ID: ic_stable_structures::memory_manager::MemoryId =
    ic_stable_structures::memory_manager::MemoryId::new(19);
const VAPID_MEMORY_ID: ic_stable_structures::memory_manager::MemoryId =
    ic_stable_structures::memory_manager::MemoryId::new(20);
const TEST_SEND_MEMORY_ID: ic_stable_structures::memory_manager::MemoryId =
    ic_stable_structures::memory_manager::MemoryId::new(21);

#[derive(Clone, Debug, Default, candid::CandidType, serde::Serialize, serde::Deserialize)]
struct PushSubscriptions(Vec<PushSubscription>);

impl Storable for PushSubscriptions {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode push subscriptions"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode push subscriptions")
    }
}

impl Storable for VapidConfig {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode VAPID configuration"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode VAPID configuration")
    }
}

thread_local! {
    static SUBSCRIPTIONS: RefCell<StableBTreeMap<Principal, PushSubscriptions, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|manager| manager.borrow().get(SUBSCRIPTIONS_MEMORY_ID))
        ));
    /// Time (ns) of each principal's last successful self-service test push.
    static LAST_TEST_SEND: RefCell<StableBTreeMap<Principal, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|manager| manager.borrow().get(TEST_SEND_MEMORY_ID))
        ));
    /// Principals with a test push in flight, so two concurrent calls cannot
    /// both pass the cooldown check before either records its success.
    static TEST_SEND_IN_FLIGHT: RefCell<std::collections::BTreeSet<Principal>> =
        const { RefCell::new(std::collections::BTreeSet::new()) };
    static VAPID_CONFIG: RefCell<StableCell<VapidConfig, Memory>> =
        RefCell::new(StableCell::init(
            MEMORY_MANAGER.with(|manager| manager.borrow().get(VAPID_MEMORY_ID)),
            VapidConfig::default(),
        ));
}

pub fn vapid_config() -> VapidConfig {
    VAPID_CONFIG.with(|config| config.borrow().get().clone())
}

pub fn initialize_vapid(config: VapidConfig) -> Result<(), String> {
    VAPID_CONFIG.with(|cell| {
        let mut cell = cell.borrow_mut();
        if !cell.get().private_key.is_empty() {
            return Err("Web Push VAPID is already initialized".to_string());
        }
        cell.set(config);
        Ok(())
    })
}

pub fn list(principal: &Principal) -> Vec<PushSubscription> {
    SUBSCRIPTIONS
        .with(|subscriptions| subscriptions.borrow().get(principal))
        .unwrap_or_default()
        .0
}

pub fn subscribe(
    principal: Principal,
    subscription: PushSubscription,
    max: usize,
) -> Result<(), String> {
    SUBSCRIPTIONS.with(|subscriptions| {
        let mut subscriptions = subscriptions.borrow_mut();
        let mut entry = subscriptions.get(&principal).unwrap_or_default();
        match entry
            .0
            .iter_mut()
            .find(|current| current.endpoint == subscription.endpoint)
        {
            Some(current) => *current = subscription,
            None => {
                if entry.0.len() >= max {
                    return Err(format!(
                        "principal already has the maximum of {max} push subscriptions"
                    ));
                }
                entry.0.push(subscription);
            }
        }
        subscriptions.insert(principal, entry);
        Ok(())
    })
}

pub fn unsubscribe(principal: Principal, endpoint: &str) {
    SUBSCRIPTIONS.with(|subscriptions| {
        let mut subscriptions = subscriptions.borrow_mut();
        if let Some(mut entry) = subscriptions.get(&principal) {
            entry
                .0
                .retain(|subscription| subscription.endpoint != endpoint);
            if entry.0.is_empty() {
                subscriptions.remove(&principal);
            } else {
                subscriptions.insert(principal, entry);
            }
        }
    });
}

pub fn remove_if_unchanged(principal: Principal, sent: &PushSubscription) -> bool {
    SUBSCRIPTIONS.with(|subscriptions| {
        let mut subscriptions = subscriptions.borrow_mut();
        let Some(mut entry) = subscriptions.get(&principal) else {
            return false;
        };
        let old_len = entry.0.len();
        entry.0.retain(|current| current != sent);
        if entry.0.len() == old_len {
            return false;
        }
        if entry.0.is_empty() {
            subscriptions.remove(&principal);
        } else {
            subscriptions.insert(principal, entry);
        }
        true
    })
}

pub fn last_test_send(principal: &Principal) -> Option<u64> {
    LAST_TEST_SEND.with(|map| map.borrow().get(principal))
}

pub fn record_test_send(principal: Principal, now: u64) {
    LAST_TEST_SEND.with(|map| map.borrow_mut().insert(principal, now));
}

/// Returns false when a test push for `principal` is already in flight.
pub fn begin_test_send(principal: Principal) -> bool {
    TEST_SEND_IN_FLIGHT.with(|set| set.borrow_mut().insert(principal))
}

pub fn end_test_send(principal: &Principal) {
    TEST_SEND_IN_FLIGHT.with(|set| set.borrow_mut().remove(principal));
}
