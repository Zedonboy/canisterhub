//! Co-owner devices: extra principals (typically the same person's other
//! Internet Identity) that the owner has authorised to act as them.
//!
//! A device resolves to its owner at every owner-keyed check (`owner_of`), so
//! it sees and manages exactly the owner's projects. Only the owner manages the
//! device list. Controller changes on the owner's canisters are made by the
//! browser (the backend is not a controller of them); this module only records
//! the authorisation.

use crate::{Memory, MEMORY_MANAGER};
use candid::{CandidType, Principal};
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, cell::RefCell};

const DEVICES_MEMORY_ID: ic_stable_structures::memory_manager::MemoryId =
    ic_stable_structures::memory_manager::MemoryId::new(22);
const MAX_DEVICES_PER_OWNER: usize = 10;
const MAX_LABEL_BYTES: usize = 64;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct Device {
    pub principal: Principal,
    pub label: String,
    pub added_at: u64,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
struct DeviceRecord {
    owner: Principal,
    label: String,
    added_at: u64,
}

impl Storable for DeviceRecord {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode device record"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode device record")
    }
}

thread_local! {
    /// device principal -> its owner's record.
    static DEVICES: RefCell<StableBTreeMap<Principal, DeviceRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|manager| manager.borrow().get(DEVICES_MEMORY_ID))
        ));
}

/// The owner `principal` acts as: its owner if it is a device, else itself.
pub fn owner_of(principal: Principal) -> Principal {
    DEVICES.with(|devices| {
        devices
            .borrow()
            .get(&principal)
            .map_or(principal, |record| record.owner)
    })
}

pub fn list(owner: Principal) -> Vec<Device> {
    DEVICES.with(|devices| {
        let mut list: Vec<Device> = devices
            .borrow()
            .iter()
            .filter(|entry| entry.value().owner == owner)
            .map(|entry| Device {
                principal: *entry.key(),
                label: entry.value().label,
                added_at: entry.value().added_at,
            })
            .collect();
        list.sort_by_key(|device| device.added_at);
        list
    })
}

/// `owns_projects` says whether `device` already owns projects of its own,
/// which adding it as a device would hide from it.
pub fn add(
    owner: Principal,
    device: Principal,
    label: String,
    owns_projects: bool,
    now: u64,
) -> Result<Device, String> {
    if device == Principal::anonymous() {
        return Err("a device principal must not be anonymous".to_string());
    }
    if device == owner {
        return Err("that principal is already the owner".to_string());
    }
    if label.trim().is_empty() || label.len() > MAX_LABEL_BYTES {
        return Err(format!(
            "device label must be between 1 and {MAX_LABEL_BYTES} bytes"
        ));
    }
    if owns_projects {
        return Err(
            "that principal already owns projects of its own; adding it as a device would hide them"
                .to_string(),
        );
    }
    DEVICES.with(|devices| {
        let mut devices = devices.borrow_mut();
        if devices.contains_key(&device) {
            return Err("that principal is already a device".to_string());
        }
        // A principal that has devices of its own is itself an owner.
        if devices.iter().any(|entry| entry.value().owner == device) {
            return Err("that principal already has devices of its own".to_string());
        }
        let count = devices
            .iter()
            .filter(|entry| entry.value().owner == owner)
            .count();
        if count >= MAX_DEVICES_PER_OWNER {
            return Err(format!(
                "at most {MAX_DEVICES_PER_OWNER} devices may be added"
            ));
        }
        devices.insert(
            device,
            DeviceRecord {
                owner,
                label: label.clone(),
                added_at: now,
            },
        );
        Ok(Device {
            principal: device,
            label,
            added_at: now,
        })
    })
}

pub fn remove(owner: Principal, device: Principal) -> Result<(), String> {
    DEVICES.with(|devices| {
        let mut devices = devices.borrow_mut();
        match devices.get(&device) {
            Some(record) if record.owner == owner => {
                devices.remove(&device);
                Ok(())
            }
            _ => Err("that principal is not one of your devices".to_string()),
        }
    })
}
