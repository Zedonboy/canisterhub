#![cfg(feature = "ic")]

use candid::Principal;
use canister_hub_sdk::permissions::{Access, PermissionEntry, PermissionStore};
use std::cell::RefCell;

thread_local! {
    static ENTRIES: RefCell<Vec<PermissionEntry>> = const { RefCell::new(Vec::new()) };
}

struct Store;

impl PermissionStore for Store {
    fn get(module: &str, principal: &Principal) -> Option<Access> {
        ENTRIES.with(|entries| {
            entries
                .borrow()
                .iter()
                .find(|entry| entry.module == module && entry.principal == *principal)
                .map(|entry| entry.access)
        })
    }

    fn set(entry: PermissionEntry) -> Result<(), String> {
        ENTRIES.with(|entries| entries.borrow_mut().push(entry));
        Ok(())
    }

    fn remove(module: &str, principal: &Principal) -> Result<(), String> {
        ENTRIES.with(|entries| {
            entries
                .borrow_mut()
                .retain(|entry| entry.module != module || entry.principal != *principal)
        });
        Ok(())
    }

    fn list(module: Option<&str>) -> Vec<PermissionEntry> {
        ENTRIES.with(|entries| {
            entries
                .borrow()
                .iter()
                .filter(|entry| module.is_none_or(|name| entry.module == name))
                .cloned()
                .collect()
        })
    }
}

canister_hub_sdk::permission_api!(Store);

#[test]
fn generated_read_api_delegates_to_store() {
    let principal = Principal::from_slice(&[7; 10]);
    Store::set(PermissionEntry {
        module: "orders".to_string(),
        principal,
        access: Access::Write,
    })
    .unwrap();

    assert_eq!(
        get_permission("orders".to_string(), principal),
        Some(Access::Write)
    );
    assert_eq!(list_permissions(Some("orders".to_string())).len(), 1);
}
