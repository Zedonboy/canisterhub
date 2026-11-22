//! Project devices: extra principals (typically the same person's other
//! Internet Identity) that a project's owner has authorised to work on that one
//! project.
//!
//! A device sees and manages only the projects it was added to; it is never
//! treated as the owner. Only the project's owner manages its device list.
//! Controller changes on the project's canisters are made by the browser (the
//! backend is not a controller of them); this module only records the
//! authorisation.

use crate::{Memory, MEMORY_MANAGER};
use candid::{CandidType, Principal};
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, cell::RefCell};

const DEVICES_MEMORY_ID: ic_stable_structures::memory_manager::MemoryId =
    ic_stable_structures::memory_manager::MemoryId::new(23);
const MAX_DEVICES_PER_PROJECT: usize = 10;
const MAX_LABEL_BYTES: usize = 64;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct Device {
    pub principal: Principal,
    pub label: String,
    pub added_at: u64,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
struct DeviceRecord {
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
    /// "<project id>:<device principal>" -> the device's record. A principal's
    /// text form never contains ':', so the key is unambiguous.
    static DEVICES: RefCell<StableBTreeMap<String, DeviceRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|manager| manager.borrow().get(DEVICES_MEMORY_ID))
        ));
}

fn key(project_id: &str, device: Principal) -> String {
    format!("{project_id}:{device}")
}

fn prefix(project_id: &str) -> String {
    format!("{project_id}:")
}

/// Whether `principal` was added as a device of `project_id`.
pub fn is_device(project_id: &str, principal: Principal) -> bool {
    DEVICES.with(|devices| devices.borrow().contains_key(&key(project_id, principal)))
}

/// Ids of every project `principal` was added to as a device.
pub fn projects_of(principal: Principal) -> Vec<String> {
    let suffix = format!(":{principal}");
    DEVICES.with(|devices| {
        devices
            .borrow()
            .iter()
            .filter_map(|entry| entry.key().strip_suffix(&suffix).map(str::to_string))
            .collect()
    })
}

pub fn list(project_id: &str) -> Vec<Device> {
    let prefix = prefix(project_id);
    DEVICES.with(|devices| {
        let mut list: Vec<Device> = devices
            .borrow()
            .iter()
            .filter_map(|entry| {
                let principal = entry.key().strip_prefix(&prefix)?;
                Some(Device {
                    principal: Principal::from_text(principal).ok()?,
                    label: entry.value().label,
                    added_at: entry.value().added_at,
                })
            })
            .collect();
        list.sort_by_key(|device| device.added_at);
        list
    })
}

pub fn add(
    project_id: &str,
    owner: Principal,
    device: Principal,
    label: String,
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
    if is_device(project_id, device) {
        return Err("that principal is already a device".to_string());
    }
    if list(project_id).len() >= MAX_DEVICES_PER_PROJECT {
        return Err(format!(
            "at most {MAX_DEVICES_PER_PROJECT} devices may be added to a project"
        ));
    }
    DEVICES.with(|devices| {
        devices.borrow_mut().insert(
            key(project_id, device),
            DeviceRecord {
                label: label.clone(),
                added_at: now,
            },
        );
    });
    Ok(Device {
        principal: device,
        label,
        added_at: now,
    })
}

pub fn remove(project_id: &str, device: Principal) -> Result<(), String> {
    DEVICES.with(|devices| {
        devices
            .borrow_mut()
            .remove(&key(project_id, device))
            .map(|_| ())
            .ok_or_else(|| "that principal is not a device of this project".to_string())
    })
}

/// Drops every device of a deleted project.
pub fn remove_project(project_id: &str) {
    let prefix = prefix(project_id);
    DEVICES.with(|devices| {
        let mut devices = devices.borrow_mut();
        let keys: Vec<String> = devices
            .iter()
            .filter(|entry| entry.key().starts_with(&prefix))
            .map(|entry| entry.key().clone())
            .collect();
        for key in keys {
            devices.remove(&key);
        }
    });
}
