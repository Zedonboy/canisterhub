//! The functional core of ic-kv - the same architecture as
//! `ic-sql`'s `src/engine.rs` (see that file's doc comment for the full
//! rationale), applied to a much simpler data model. Every function here is
//! a pure transformation from its arguments to its return value: nothing
//! touches a `thread_local`, calls into `ic_cdk`, or reads any other hidden
//! state, and a "mutation" is a function returning a *new* [`Store`] value
//! rather than changing the one it was given. `Store` is an
//! [`im::OrdMap`](https://docs.rs/im), so that new value shares all
//! unaffected structure with the old one - `O(log n)`, not a deep copy.
//!
//! This module is fully testable with plain `cargo test`, no canister
//! runtime or Wasm build required - see the tests below.

use candid::CandidType;
use im::OrdMap;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Boolean(bool),
    Bytes(Vec<u8>),
}

/// The whole store: an immutable map of key to [`Value`]. Every function
/// that "changes" a `Store` returns a new one - see this module's doc
/// comment.
pub type Store = OrdMap<String, Value>;

pub fn new_store() -> Store {
    OrdMap::new()
}

pub fn get(store: &Store, key: &str) -> Option<Value> {
    store.get(key).cloned()
}

pub fn get_many(store: &Store, keys: &[String]) -> Vec<Option<Value>> {
    keys.iter().map(|key| get(store, key)).collect()
}

/// Sets `key` to `value`, returning the new store and whatever `key`'s value
/// was before this call (`None` if it didn't exist).
pub fn set(store: &Store, key: String, value: Value) -> (Store, Option<Value>) {
    let mut new_store = store.clone();
    let old = new_store.insert(key, value);
    (new_store, old)
}

/// Sets every `(key, value)` pair in `entries`, later entries winning on a
/// repeated key - one new `Store`, not one per entry.
pub fn set_many(store: &Store, entries: Vec<(String, Value)>) -> Store {
    let mut new_store = store.clone();
    for (key, value) in entries {
        new_store.insert(key, value);
    }
    new_store
}

/// Removes `key`, returning the new store and the value it held (`None` if
/// it didn't exist).
pub fn delete(store: &Store, key: &str) -> (Store, Option<Value>) {
    let mut new_store = store.clone();
    let old = new_store.remove(key);
    (new_store, old)
}

pub fn exists(store: &Store, key: &str) -> bool {
    store.contains_key(key)
}

/// All keys, optionally restricted to ones starting with `prefix` - in
/// sorted order (`Store`'s underlying `im::OrdMap` is key-ordered).
pub fn keys(store: &Store, prefix: Option<&str>) -> Vec<String> {
    store
        .keys()
        .filter(|key| match prefix {
            Some(p) => key.starts_with(p),
            None => true,
        })
        .cloned()
        .collect()
}

pub fn len(store: &Store) -> u64 {
    store.len() as u64
}

/// Empties the store, returning the new (empty) store and how many entries
/// it held.
pub fn clear(store: &Store) -> (Store, u64) {
    (OrdMap::new(), store.len() as u64)
}

// ============================================================================
// Stable-memory snapshot (candid-friendly; used only at upgrade boundaries)
// ============================================================================

/// A [`Store`]'s content as a plain, `CandidType`-friendly value - `im`'s
/// persistent maps aren't themselves `CandidType`, so this is the shape
/// `lib.rs` actually saves/restores via `ic_cdk::storage::stable_save`/
/// `stable_restore`. Only ever built or consumed at an upgrade boundary,
/// never on the hot path - see `lib.rs`'s "Persistence" doc section.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct Snapshot {
    pub entries: Vec<(String, Value)>,
}

impl From<&Store> for Snapshot {
    fn from(store: &Store) -> Self {
        Snapshot {
            entries: store.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        }
    }
}

impl From<Snapshot> for Store {
    fn from(snapshot: Snapshot) -> Self {
        snapshot.entries.into_iter().collect()
    }
}

// ============================================================================
// Tests - pure logic, no ic_cdk/Wasm/canister runtime needed
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_on_an_empty_store_is_none() {
        let store = new_store();
        assert_eq!(get(&store, "missing"), None);
    }

    #[test]
    fn set_then_get_round_trips_the_value() {
        let store = new_store();
        let (store, old) = set(&store, "a".to_string(), Value::Integer(1));
        assert_eq!(old, None);
        assert_eq!(get(&store, "a"), Some(Value::Integer(1)));
    }

    #[test]
    fn set_returns_the_previous_value_on_overwrite() {
        let store = new_store();
        let (store, _) = set(&store, "a".to_string(), Value::Text("first".to_string()));
        let (store, old) = set(&store, "a".to_string(), Value::Text("second".to_string()));
        assert_eq!(old, Some(Value::Text("first".to_string())));
        assert_eq!(get(&store, "a"), Some(Value::Text("second".to_string())));
    }

    #[test]
    fn set_never_mutates_the_store_it_was_given() {
        let store = new_store();
        let (before, _) = set(&store, "a".to_string(), Value::Integer(1));
        let (_after, _) = set(&before, "b".to_string(), Value::Integer(2));
        // `before` must not have gained "b" just because a later call built
        // on top of it - the core claim of "functional" for this module.
        assert_eq!(get(&before, "b"), None);
        assert_eq!(keys(&before, None), vec!["a".to_string()]);
    }

    #[test]
    fn delete_removes_the_key_and_returns_its_former_value() {
        let store = new_store();
        let (store, _) = set(&store, "a".to_string(), Value::Boolean(true));
        let (store, removed) = delete(&store, "a");
        assert_eq!(removed, Some(Value::Boolean(true)));
        assert_eq!(get(&store, "a"), None);
    }

    #[test]
    fn delete_on_a_missing_key_is_a_no_op() {
        let store = new_store();
        let (store, removed) = delete(&store, "missing");
        assert_eq!(removed, None);
        assert_eq!(len(&store), 0);
    }

    #[test]
    fn exists_reflects_current_membership() {
        let store = new_store();
        assert!(!exists(&store, "a"));
        let (store, _) = set(&store, "a".to_string(), Value::Null);
        assert!(exists(&store, "a"));
        let (store, _) = delete(&store, "a");
        assert!(!exists(&store, "a"));
    }

    #[test]
    fn keys_without_a_prefix_lists_everything_sorted() {
        let store = new_store();
        let store = set_many(
            &store,
            vec![
                ("b".to_string(), Value::Null),
                ("a".to_string(), Value::Null),
                ("c".to_string(), Value::Null),
            ],
        );
        assert_eq!(
            keys(&store, None),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn keys_with_a_prefix_filters() {
        let store = new_store();
        let store = set_many(
            &store,
            vec![
                ("user:1".to_string(), Value::Null),
                ("user:2".to_string(), Value::Null),
                ("order:1".to_string(), Value::Null),
            ],
        );
        assert_eq!(
            keys(&store, Some("user:")),
            vec!["user:1".to_string(), "user:2".to_string()]
        );
    }

    #[test]
    fn set_many_lets_a_later_entry_win_on_a_repeated_key() {
        let store = new_store();
        let store = set_many(
            &store,
            vec![
                ("a".to_string(), Value::Integer(1)),
                ("a".to_string(), Value::Integer(2)),
            ],
        );
        assert_eq!(get(&store, "a"), Some(Value::Integer(2)));
        assert_eq!(len(&store), 1);
    }

    #[test]
    fn get_many_preserves_order_and_reports_missing_keys_as_none() {
        let store = new_store();
        let (store, _) = set(&store, "a".to_string(), Value::Integer(1));
        let results = get_many(&store, &["a".to_string(), "missing".to_string()]);
        assert_eq!(results, vec![Some(Value::Integer(1)), None]);
    }

    #[test]
    fn clear_empties_the_store_and_reports_how_many_entries_it_held() {
        let store = new_store();
        let store = set_many(
            &store,
            vec![
                ("a".to_string(), Value::Null),
                ("b".to_string(), Value::Null),
            ],
        );
        let (store, count) = clear(&store);
        assert_eq!(count, 2);
        assert_eq!(len(&store), 0);
    }

    #[test]
    fn snapshot_round_trips_a_store_exactly() {
        let store = new_store();
        let store = set_many(
            &store,
            vec![
                ("a".to_string(), Value::Integer(1)),
                ("b".to_string(), Value::Bytes(vec![1, 2, 3])),
            ],
        );

        let snapshot = Snapshot::from(&store);
        let restored: Store = snapshot.into();

        assert_eq!(keys(&restored, None), keys(&store, None));
        assert_eq!(get(&restored, "a"), get(&store, "a"));
        assert_eq!(get(&restored, "b"), get(&store, "b"));
    }
}
