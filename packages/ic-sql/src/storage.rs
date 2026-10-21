//! Direct stable-memory persistence for the SQL catalog and data.
//!
//! Tables, columns, and rows occupy separate `StableBTreeMap`s. Rows use a
//! composite `(table_id, row_id)` key, so a table's rows are contiguous and
//! can later be cursor-scanned without allocating a stable-memory region per
//! table. Configuration and permissions are stable too; no upgrade hook ever
//! serializes the database as one heap-sized value.

use crate::auth::PermissionLevel;
use crate::config::Config;
use crate::engine::{
    ColumnDef, ConstraintDescription, Database, IndexDefinition, RelationalConstraints, Row,
    SqlValue, Table, TableDescription,
};
use crate::rls::RlsPolicy;
use candid::{CandidType, Principal};
use canister_hub_sdk::permissions::{Access, PermissionEntry, PermissionStore};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::{Bound, Storable},
    DefaultMemoryImpl, StableBTreeMap, StableCell,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{borrow::Cow, cell::RefCell};

type Memory = VirtualMemory<DefaultMemoryImpl>;

const TABLES_MEMORY_ID: MemoryId = MemoryId::new(0);
const TABLE_NAMES_MEMORY_ID: MemoryId = MemoryId::new(1);
const COLUMNS_MEMORY_ID: MemoryId = MemoryId::new(2);
const ROWS_MEMORY_ID: MemoryId = MemoryId::new(3);
const NEXT_TABLE_ID_MEMORY_ID: MemoryId = MemoryId::new(4);
const CONFIG_MEMORY_ID: MemoryId = MemoryId::new(5);
const PERMISSIONS_MEMORY_ID: MemoryId = MemoryId::new(6);
const RLS_POLICIES_MEMORY_ID: MemoryId = MemoryId::new(7);
const INDEX_ENTRIES_MEMORY_ID: MemoryId = MemoryId::new(8);
const DYNAMIC_CONFIG_MEMORY_ID: MemoryId = MemoryId::new(9);
const DYNAMIC_CONFIG_MIGRATED_MEMORY_ID: MemoryId = MemoryId::new(10);

fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes).expect("stable value serialization failed");
    bytes
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> T {
    ciborium::from_reader(bytes).expect("stable value deserialization failed")
}

macro_rules! cbor_storable {
    ($ty:ty) => {
        impl Storable for $ty {
            const BOUND: Bound = Bound::Unbounded;
            fn to_bytes(&self) -> Cow<'_, [u8]> {
                Cow::Owned(encode(self))
            }
            fn into_bytes(self) -> Vec<u8> {
                encode(&self)
            }
            fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
                decode(bytes.as_ref())
            }
        }
    };
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TableMeta {
    name: String,
    next_row_id: u64,
    row_count: u64,
    #[serde(default)]
    constraints: RelationalConstraints,
    #[serde(default)]
    index_ready: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ColumnKey {
    table_id: u64,
    position: u32,
}

impl Storable for ColumnKey {
    const BOUND: Bound = Bound::Bounded {
        max_size: 12,
        is_fixed_size: true,
    };
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.into_bytes())
    }
    fn into_bytes(self) -> Vec<u8> {
        [
            self.table_id.to_be_bytes().as_slice(),
            self.position.to_be_bytes().as_slice(),
        ]
        .concat()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let bytes = bytes.as_ref();
        Self {
            table_id: u64::from_be_bytes(
                bytes[0..8].try_into().expect("invalid stable column key"),
            ),
            position: u32::from_be_bytes(
                bytes[8..12].try_into().expect("invalid stable column key"),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RowKey {
    table_id: u64,
    row_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct IndexEntryKey {
    table_id: u64,
    index_position: u32,
    encoded_key: Vec<u8>,
    row_id: u64,
}

impl Storable for IndexEntryKey {
    const BOUND: Bound = Bound::Unbounded;
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.clone().into_bytes())
    }
    fn into_bytes(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(20 + self.encoded_key.len());
        bytes.extend_from_slice(&self.table_id.to_be_bytes());
        bytes.extend_from_slice(&self.index_position.to_be_bytes());
        bytes.extend_from_slice(&(self.encoded_key.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.encoded_key);
        bytes.extend_from_slice(&self.row_id.to_be_bytes());
        bytes
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let bytes = bytes.as_ref();
        let key_len =
            u32::from_be_bytes(bytes[12..16].try_into().expect("invalid index key")) as usize;
        Self {
            table_id: u64::from_be_bytes(bytes[0..8].try_into().expect("invalid index table id")),
            index_position: u32::from_be_bytes(
                bytes[8..12].try_into().expect("invalid index position"),
            ),
            encoded_key: bytes[16..16 + key_len].to_vec(),
            row_id: u64::from_be_bytes(
                bytes[16 + key_len..24 + key_len]
                    .try_into()
                    .expect("invalid index row id"),
            ),
        }
    }
}

impl Storable for RowKey {
    const BOUND: Bound = Bound::Bounded {
        max_size: 16,
        is_fixed_size: true,
    };
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.into_bytes())
    }
    fn into_bytes(self) -> Vec<u8> {
        [
            self.table_id.to_be_bytes().as_slice(),
            self.row_id.to_be_bytes().as_slice(),
        ]
        .concat()
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let bytes = bytes.as_ref();
        Self {
            table_id: u64::from_be_bytes(bytes[0..8].try_into().expect("invalid stable row key")),
            row_id: u64::from_be_bytes(bytes[8..16].try_into().expect("invalid stable row key")),
        }
    }
}

cbor_storable!(TableMeta);
cbor_storable!(ColumnDef);
cbor_storable!(Row);
cbor_storable!(Config);
cbor_storable!(PermissionLevel);
cbor_storable!(RlsPolicy);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static TABLES: RefCell<StableBTreeMap<u64, TableMeta, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(TABLES_MEMORY_ID)))
    );
    static TABLE_NAMES: RefCell<StableBTreeMap<String, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(TABLE_NAMES_MEMORY_ID)))
    );
    static COLUMNS: RefCell<StableBTreeMap<ColumnKey, ColumnDef, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(COLUMNS_MEMORY_ID)))
    );
    static ROWS: RefCell<StableBTreeMap<RowKey, Row, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ROWS_MEMORY_ID)))
    );
    static NEXT_TABLE_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(NEXT_TABLE_ID_MEMORY_ID)), 1)
    );
    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(CONFIG_MEMORY_ID)), Config::default())
    );
    static PERMISSIONS: RefCell<StableBTreeMap<Principal, PermissionLevel, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PERMISSIONS_MEMORY_ID)))
    );
    static RLS_POLICIES: RefCell<StableBTreeMap<String, RlsPolicy, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(RLS_POLICIES_MEMORY_ID)))
    );
    static INDEX_ENTRIES: RefCell<StableBTreeMap<IndexEntryKey, u8, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(INDEX_ENTRIES_MEMORY_ID)))
    );
}

fn encode_index_values(values: impl Iterator<Item = SqlValue>) -> Vec<u8> {
    encode(&values.collect::<Vec<_>>())
}

fn effective_indexes(table: &Table) -> Vec<IndexDefinition> {
    let mut indexes = table.constraints.indexes.clone();
    for (position, key) in table.constraints.unique.iter().enumerate() {
        if !indexes
            .iter()
            .any(|index| index.columns == key.columns && index.unique)
        {
            indexes.push(IndexDefinition {
                name: if key.primary_key {
                    "__primary_key".to_string()
                } else {
                    format!("__unique_{position}")
                },
                columns: key.columns.clone(),
                unique: true,
            });
        }
    }
    indexes
}

fn rebuild_indexes(table_id: u64, table: &Table) {
    let stale = INDEX_ENTRIES.with(|entries| {
        entries
            .borrow()
            .range(
                IndexEntryKey {
                    table_id,
                    index_position: 0,
                    encoded_key: vec![],
                    row_id: 0,
                }..=IndexEntryKey {
                    table_id,
                    index_position: u32::MAX,
                    encoded_key: vec![],
                    row_id: u64::MAX,
                },
            )
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>()
    });
    INDEX_ENTRIES.with(|entries| {
        let mut entries = entries.borrow_mut();
        for key in stale {
            entries.remove(&key);
        }
        for (index_position, index) in effective_indexes(table).iter().enumerate() {
            let positions = index
                .columns
                .iter()
                .map(|name| {
                    table
                        .columns
                        .iter()
                        .position(|column| &column.name == name)
                        .expect("validated index column")
                })
                .collect::<Vec<_>>();
            for (row_id, row) in &table.rows {
                let encoded_key =
                    encode_index_values(positions.iter().map(|position| {
                        row.values.get(*position).cloned().unwrap_or(SqlValue::Null)
                    }));
                entries.insert(
                    IndexEntryKey {
                        table_id,
                        index_position: index_position as u32,
                        encoded_key,
                        row_id: *row_id,
                    },
                    0,
                );
            }
        }
    });
}

fn index_entry_keys(table_id: u64, table: &Table, row_id: u64, row: &Row) -> Vec<IndexEntryKey> {
    effective_indexes(table)
        .iter()
        .enumerate()
        .map(|(index_position, index)| {
            let encoded_key = encode_index_values(index.columns.iter().map(|name| {
                let position = table
                    .columns
                    .iter()
                    .position(|column| &column.name == name)
                    .expect("validated index column");
                row.values.get(position).cloned().unwrap_or(SqlValue::Null)
            }));
            IndexEntryKey {
                table_id,
                index_position: index_position as u32,
                encoded_key,
                row_id,
            }
        })
        .collect()
}

fn update_indexes(table_id: u64, old: Option<&Table>, new: &Table) {
    let Some(old) =
        old.filter(|old| old.columns == new.columns && old.constraints == new.constraints)
    else {
        rebuild_indexes(table_id, new);
        return;
    };
    INDEX_ENTRIES.with(|entries| {
        let mut entries = entries.borrow_mut();
        for (row_id, row) in &old.rows {
            if new.rows.get(row_id) != Some(row) {
                for key in index_entry_keys(table_id, old, *row_id, row) {
                    entries.remove(&key);
                }
            }
        }
        for (row_id, row) in &new.rows {
            if old.rows.get(row_id) != Some(row) {
                for key in index_entry_keys(table_id, new, *row_id, row) {
                    entries.insert(key, 0);
                }
            }
        }
    });
}

fn columns_for(table_id: u64) -> Vec<ColumnDef> {
    COLUMNS.with(|columns| {
        columns
            .borrow()
            .range(
                ColumnKey {
                    table_id,
                    position: 0,
                }..=ColumnKey {
                    table_id,
                    position: u32::MAX,
                },
            )
            .map(|entry| entry.value())
            .collect()
    })
}

fn rows_for(table_id: u64) -> im::OrdMap<u64, Row> {
    ROWS.with(|rows| {
        rows.borrow()
            .range(
                RowKey {
                    table_id,
                    row_id: 0,
                }..=RowKey {
                    table_id,
                    row_id: u64::MAX,
                },
            )
            .map(|entry| (entry.key().row_id, entry.value()))
            .collect()
    })
}

pub fn load_database() -> Database {
    let tables = TABLES.with(|tables| {
        tables
            .borrow()
            .iter()
            .map(|entry| {
                let table_id = *entry.key();
                let meta = entry.value();
                (
                    meta.name,
                    Table {
                        columns: columns_for(table_id),
                        constraints: meta.constraints,
                        rows: rows_for(table_id),
                        next_row_id: meta.next_row_id,
                    },
                )
            })
            .collect()
    });
    Database { tables }
}

/// Uses a durable single-column index for a simple equality predicate. Tables
/// written by older Wasm versions have `index_ready = false` and safely fall
/// back to a full row load until their next mutation rebuilds the indexes.
pub fn load_database_for_query(sql: &str) -> Database {
    let Ok(Some((table_name, column, value))) = crate::engine::equality_lookup(sql) else {
        return load_database();
    };
    let Some(table_id) = TABLE_NAMES.with(|names| names.borrow().get(&table_name)) else {
        return load_database();
    };
    let Some(meta) = TABLES.with(|tables| tables.borrow().get(&table_id)) else {
        return load_database();
    };
    if !meta.index_ready {
        return load_database();
    }
    let table_columns = columns_for(table_id);
    let table = Table {
        columns: table_columns.clone(),
        constraints: meta.constraints.clone(),
        rows: im::OrdMap::new(),
        next_row_id: meta.next_row_id,
    };
    let Some((position, _)) = effective_indexes(&table)
        .iter()
        .enumerate()
        .find(|(_, index)| index.columns.as_slice() == [column.as_str()])
    else {
        return load_database();
    };
    let encoded_key = encode_index_values(std::iter::once(value));
    let start = IndexEntryKey {
        table_id,
        index_position: position as u32,
        encoded_key: encoded_key.clone(),
        row_id: 0,
    };
    let end = IndexEntryKey {
        table_id,
        index_position: position as u32,
        encoded_key,
        row_id: u64::MAX,
    };
    let row_ids = INDEX_ENTRIES.with(|entries| {
        entries
            .borrow()
            .range(start..=end)
            .map(|entry| entry.key().row_id)
            .collect::<Vec<_>>()
    });
    let selected = ROWS.with(|rows| {
        let rows = rows.borrow();
        row_ids
            .into_iter()
            .filter_map(|row_id| {
                rows.get(&RowKey { table_id, row_id })
                    .map(|row| (row_id, row))
            })
            .collect::<im::OrdMap<_, _>>()
    });
    let mut database = load_database();
    if let Some(existing) = database.tables.get(&table_name) {
        let mut filtered = existing.clone();
        filtered.rows = selected;
        database.tables.insert(table_name, filtered);
    }
    database
}

pub fn list_tables() -> Vec<String> {
    TABLE_NAMES.with(|names| {
        names
            .borrow()
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    })
}

pub fn describe_table(table_name: &str) -> Result<TableDescription, String> {
    let name = table_name.to_lowercase();
    let table_id = TABLE_NAMES
        .with(|names| names.borrow().get(&name))
        .ok_or_else(|| format!("Table '{name}' not found"))?;
    let meta = TABLES
        .with(|tables| tables.borrow().get(&table_id))
        .ok_or_else(|| format!("Table '{name}' has missing metadata"))?;
    Ok(TableDescription {
        name,
        columns: columns_for(table_id),
        row_count: meta.row_count,
    })
}

/// Direct, SQL-parser-free page of `table_name`'s rows, in `row_id` order
/// (the same effective order a plain `SELECT * FROM table` with no
/// `ORDER BY` already returns, since a table's rows are iterated in that
/// order everywhere else too) - backs `get_table_rows`, the controller-only
/// fast path a table-browser-style admin UI should use to page through
/// rows instead of building and sending `SELECT ... LIMIT ... OFFSET ...`
/// SQL text through `query`.
///
/// Unlike `load_database`/`load_database_for_query` (what `query`/`execute`
/// go through), this never materializes any other table, and never
/// materializes more of *this* table than the page actually asked for: it
/// range-scans directly over this table's own `(table_id, row_id)` key
/// span in the stable `ROWS` map, skipping straight to `offset` and
/// stopping at `limit` rather than collecting the whole table into an
/// `im::OrdMap` first and discarding everything outside the page after.
pub fn table_rows(table_name: &str, limit: u64, offset: u64) -> Result<(Vec<ColumnDef>, Vec<Row>), String> {
    let name = table_name.to_lowercase();
    let table_id = TABLE_NAMES
        .with(|names| names.borrow().get(&name))
        .ok_or_else(|| format!("Table '{name}' not found"))?;
    let columns = columns_for(table_id);
    let rows = ROWS.with(|rows| {
        rows.borrow()
            .range(RowKey { table_id, row_id: 0 }..=RowKey { table_id, row_id: u64::MAX })
            .map(|entry| entry.value())
            .skip(offset as usize)
            .take(limit as usize)
            .collect::<Vec<_>>()
    });
    Ok((columns, rows))
}

pub fn describe_constraints(table_name: &str) -> Result<ConstraintDescription, String> {
    let name = table_name.to_lowercase();
    let table_id = TABLE_NAMES
        .with(|names| names.borrow().get(&name))
        .ok_or_else(|| format!("Table '{name}' not found"))?;
    let meta = TABLES
        .with(|tables| tables.borrow().get(&table_id))
        .ok_or_else(|| format!("Table '{name}' has missing metadata"))?;
    Ok(ConstraintDescription {
        table_name: name,
        constraints: meta.constraints,
    })
}

// Wire-compatible with the snapshot written by ic-sql releases before
// stable structures. Kept only so the first upgrade to this layout can move
// existing data in-place; subsequent upgrades see the MemoryManager's `MGR`
// header and skip this path.
#[derive(CandidType, Deserialize)]
struct LegacySnapshot {
    tables: Vec<(String, LegacyTableSnapshot)>,
}

#[derive(CandidType, Deserialize)]
struct LegacyTableSnapshot {
    columns: Vec<ColumnDef>,
    rows: Vec<(u64, Row)>,
    next_row_id: u64,
}

impl From<LegacySnapshot> for Database {
    fn from(snapshot: LegacySnapshot) -> Self {
        Self {
            tables: snapshot
                .tables
                .into_iter()
                .map(|(name, table)| {
                    (
                        name,
                        Table {
                            columns: table.columns,
                            constraints: RelationalConstraints::default(),
                            rows: table.rows.into_iter().collect(),
                            next_row_id: table.next_row_id,
                        },
                    )
                })
                .collect(),
        }
    }
}

/// Migrates the single Candid snapshot written by the former
/// `pre_upgrade` hook. The old hook has already committed that snapshot
/// before this Wasm starts, so migration is atomic with the upgrade: a trap
/// rejects the upgrade and leaves the old module/state active.
pub fn migrate_legacy_snapshot_if_present() {
    if ic_cdk::stable::stable_size() == 0 {
        return;
    }
    let mut magic = [0; 3];
    ic_cdk::stable::stable_read(0, &mut magic);
    if &magic == b"MGR" {
        return;
    }

    let (snapshot, config, permissions): (
        LegacySnapshot,
        Config,
        Vec<(Principal, PermissionLevel)>,
    ) = ic_cdk::storage::stable_restore().expect("failed to read legacy ic-sql snapshot");

    let database: Database = snapshot.into();
    commit_database(&Database::default(), &database);
    set_config(config);
    for (principal, level) in permissions {
        set_permission(principal, level);
    }
}

fn new_table_id() -> u64 {
    NEXT_TABLE_ID.with(|counter| {
        let mut counter = counter.borrow_mut();
        let id = *counter.get();
        counter.set(id.checked_add(1).expect("table id exhausted"));
        id
    })
}

fn remove_table(table_id: u64, name: &str) {
    TABLE_NAMES.with(|names| {
        names.borrow_mut().remove(&name.to_string());
    });
    TABLES.with(|tables| {
        tables.borrow_mut().remove(&table_id);
    });
    remove_rls_policy(name);
    let column_keys: Vec<_> = COLUMNS.with(|columns| {
        columns
            .borrow()
            .range(
                ColumnKey {
                    table_id,
                    position: 0,
                }..=ColumnKey {
                    table_id,
                    position: u32::MAX,
                },
            )
            .map(|entry| *entry.key())
            .collect()
    });
    COLUMNS.with(|columns| {
        for key in column_keys {
            columns.borrow_mut().remove(&key);
        }
    });
    let row_keys: Vec<_> = ROWS.with(|rows| {
        rows.borrow()
            .range(
                RowKey {
                    table_id,
                    row_id: 0,
                }..=RowKey {
                    table_id,
                    row_id: u64::MAX,
                },
            )
            .map(|entry| *entry.key())
            .collect()
    });
    ROWS.with(|rows| {
        for key in row_keys {
            rows.borrow_mut().remove(&key);
        }
    });
    let index_keys = INDEX_ENTRIES.with(|entries| {
        entries
            .borrow()
            .range(
                IndexEntryKey {
                    table_id,
                    index_position: 0,
                    encoded_key: vec![],
                    row_id: 0,
                }..=IndexEntryKey {
                    table_id,
                    index_position: u32::MAX,
                    encoded_key: vec![],
                    row_id: u64::MAX,
                },
            )
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>()
    });
    INDEX_ENTRIES.with(|entries| {
        for key in index_keys {
            entries.borrow_mut().remove(&key);
        }
    });
}

fn write_table(table_id: u64, name: &str, old: Option<&Table>, new: &Table) {
    if old.map(|t| &t.columns) != Some(&new.columns) {
        let old_len = old.map_or(0, |t| t.columns.len());
        COLUMNS.with(|columns| {
            let mut columns = columns.borrow_mut();
            for position in 0..old_len.max(new.columns.len()) {
                let key = ColumnKey {
                    table_id,
                    position: position as u32,
                };
                if let Some(column) = new.columns.get(position) {
                    columns.insert(key, column.clone());
                } else {
                    columns.remove(&key);
                }
            }
        });
    }
    ROWS.with(|rows| {
        let mut rows = rows.borrow_mut();
        if let Some(old) = old {
            for (row_id, _) in old.rows.iter().filter(|(id, _)| !new.rows.contains_key(id)) {
                rows.remove(&RowKey {
                    table_id,
                    row_id: *row_id,
                });
            }
        }
        for (row_id, row) in new
            .rows
            .iter()
            .filter(|(id, row)| old.and_then(|t| t.rows.get(id)) != Some(*row))
        {
            rows.insert(
                RowKey {
                    table_id,
                    row_id: *row_id,
                },
                row.clone(),
            );
        }
    });
    TABLES.with(|tables| {
        tables.borrow_mut().insert(
            table_id,
            TableMeta {
                name: name.to_string(),
                next_row_id: new.next_row_id,
                row_count: new.rows.len() as u64,
                constraints: new.constraints.clone(),
                index_ready: true,
            },
        );
    });
    update_indexes(table_id, old, new);
}

/// Applies only the catalog/row differences between two successful engine
/// states. If the surrounding canister message traps, IC message atomicity
/// rolls every stable-memory write back together.
pub fn commit_database(old: &Database, new: &Database) {
    for (name, _) in old
        .tables
        .iter()
        .filter(|(name, _)| !new.tables.contains_key(*name))
    {
        if let Some(table_id) = TABLE_NAMES.with(|names| names.borrow().get(name)) {
            remove_table(table_id, name);
        }
    }
    for (name, table) in &new.tables {
        let table_id = TABLE_NAMES
            .with(|names| names.borrow().get(name))
            .unwrap_or_else(|| {
                let id = new_table_id();
                TABLE_NAMES.with(|names| {
                    names.borrow_mut().insert(name.clone(), id);
                });
                id
            });
        let old_table = old.tables.get(name);
        if old_table != Some(table) {
            write_table(table_id, name, old_table, table);
        }
    }
}

pub fn get_config() -> Config {
    CONFIG.with(|config| config.borrow().get().clone())
}
pub fn set_config(value: Config) {
    CONFIG.with(|config| {
        config.borrow_mut().set(value);
    });
}

/// Opens the SDK-managed runtime config and imports the former typed config
/// cell exactly once. The migration marker prevents a later upgrade from
/// overwriting settings changed through the dynamic `set_config` endpoint.
pub fn init_dynamic_config_store() {
    canister_hub_sdk::ic::config::init_stable_store::<Config>(
        MEMORY_MANAGER.with(|manager| manager.borrow().get(DYNAMIC_CONFIG_MEMORY_ID)),
    );

    let mut migrated = StableCell::init(
        MEMORY_MANAGER.with(|manager| manager.borrow().get(DYNAMIC_CONFIG_MIGRATED_MEMORY_ID)),
        false,
    );
    if !*migrated.get() {
        if let Some(auth_canister) = get_config().auth_canister {
            canister_hub_sdk::ic::config::set::<Config>(std::collections::HashMap::from([(
                "auth_canister".to_owned(),
                canister_hub_sdk::ic::config::ConfigValue::PrincipalId(auth_canister),
            )]))
            .expect("legacy auth canister config must satisfy the dynamic schema");
        }
        migrated.set(true);
    }
}
pub fn get_permission(principal: &Principal) -> Option<PermissionLevel> {
    PERMISSIONS.with(|permissions| permissions.borrow().get(principal))
}
pub fn set_permission(principal: Principal, level: PermissionLevel) {
    PERMISSIONS.with(|permissions| {
        permissions.borrow_mut().insert(principal, level);
    });
}
pub fn remove_permission(principal: &Principal) {
    PERMISSIONS.with(|permissions| {
        permissions.borrow_mut().remove(principal);
    });
}
pub fn list_permissions() -> Vec<(Principal, PermissionLevel)> {
    PERMISSIONS.with(|permissions| {
        permissions
            .borrow()
            .iter()
            .map(|entry| entry.into_pair())
            .collect()
    })
}

pub struct PermissionStorage;

fn permission_level_from_access(access: Access) -> PermissionLevel {
    match access {
        Access::None => PermissionLevel::Blocked,
        Access::Read => PermissionLevel::ReadOnly,
        Access::Write | Access::Admin => PermissionLevel::ReadWrite,
    }
}

fn access_from_permission_level(level: PermissionLevel) -> Access {
    match level {
        PermissionLevel::Blocked => Access::None,
        PermissionLevel::ReadOnly => Access::Read,
        PermissionLevel::ReadWrite => Access::Write,
    }
}

impl PermissionStore for PermissionStorage {
    fn get(module: &str, principal: &Principal) -> Option<Access> {
        (module == crate::DATABASE_PERMISSION_MODULE)
            .then(|| get_permission(principal).map(access_from_permission_level))
            .flatten()
    }

    fn set(entry: PermissionEntry) -> Result<(), String> {
        if entry.module != crate::DATABASE_PERMISSION_MODULE {
            return Err(format!(
                "unknown permission module '{}'; expected '{}'",
                entry.module,
                crate::DATABASE_PERMISSION_MODULE
            ));
        }
        set_permission(entry.principal, permission_level_from_access(entry.access));
        Ok(())
    }

    fn remove(module: &str, principal: &Principal) -> Result<(), String> {
        if module != crate::DATABASE_PERMISSION_MODULE {
            return Err(format!(
                "unknown permission module '{module}'; expected '{}'",
                crate::DATABASE_PERMISSION_MODULE
            ));
        }
        remove_permission(principal);
        Ok(())
    }

    fn list(module: Option<&str>) -> Vec<PermissionEntry> {
        if module.is_some_and(|module| module != crate::DATABASE_PERMISSION_MODULE) {
            return Vec::new();
        }
        list_permissions()
            .into_iter()
            .map(|(principal, level)| PermissionEntry {
                module: crate::DATABASE_PERMISSION_MODULE.to_string(),
                principal,
                access: access_from_permission_level(level),
            })
            .collect()
    }
}

pub fn get_rls_policy(table_name: &str) -> Option<RlsPolicy> {
    RLS_POLICIES.with(|policies| policies.borrow().get(&table_name.to_lowercase()))
}

pub fn set_rls_policy(policy: RlsPolicy) {
    RLS_POLICIES.with(|policies| {
        policies
            .borrow_mut()
            .insert(policy.table_name.clone(), policy);
    });
}

pub fn remove_rls_policy(table_name: &str) {
    RLS_POLICIES.with(|policies| {
        policies.borrow_mut().remove(&table_name.to_lowercase());
    });
}

pub fn list_rls_policies() -> Vec<RlsPolicy> {
    RLS_POLICIES.with(|policies| {
        policies
            .borrow()
            .iter()
            .map(|entry| entry.value())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine;

    #[test]
    fn composite_keys_sort_by_table_then_record() {
        assert!(
            RowKey {
                table_id: 1,
                row_id: u64::MAX
            } < RowKey {
                table_id: 2,
                row_id: 0
            }
        );
        assert!(
            ColumnKey {
                table_id: 3,
                position: 1
            } < ColumnKey {
                table_id: 3,
                position: 2
            }
        );
    }

    #[test]
    fn stable_catalog_round_trips_tables_columns_and_rows() {
        let empty = Database::new();
        let (with_table, _) =
            engine::apply(&empty, "CREATE TABLE stable_test (id INT, name TEXT)").unwrap();
        let (with_rows, _) = engine::apply(
            &with_table,
            "INSERT INTO stable_test VALUES (1, 'a'), (2, 'b')",
        )
        .unwrap();
        commit_database(&empty, &with_rows);
        assert_eq!(load_database(), with_rows);
        assert_eq!(list_tables(), vec!["stable_test".to_string()]);
        let description = describe_table("STABLE_TEST").unwrap();
        assert_eq!(description.row_count, 2);
        assert_eq!(description.columns.len(), 2);
        commit_database(&with_rows, &empty);
        assert_eq!(load_database(), empty);
    }

    #[test]
    fn table_rows_pages_without_touching_other_tables() {
        let empty = Database::new();
        let (database, _) = engine::apply(&empty, "CREATE TABLE rows_page_a (id INT)").unwrap();
        let (database, _) = engine::apply(&database, "CREATE TABLE rows_page_b (id INT)").unwrap();
        let (database, _) = engine::apply(
            &database,
            "INSERT INTO rows_page_a VALUES (1), (2), (3), (4), (5)",
        )
        .unwrap();
        let (database, _) = engine::apply(&database, "INSERT INTO rows_page_b VALUES (100)").unwrap();
        commit_database(&empty, &database);

        let (columns, rows) = table_rows("rows_page_a", 2, 1).unwrap();
        assert_eq!(columns, vec![ColumnDef { name: "id".to_string(), data_type: "INT".to_string() }]);
        assert_eq!(
            rows.into_iter().map(|row| row.values).collect::<Vec<_>>(),
            vec![vec![SqlValue::Integer(2)], vec![SqlValue::Integer(3)]]
        );

        // Past the end of the table's own rows - never spills into
        // `rows_page_b`, even though it immediately follows in the stable
        // `ROWS` map's key order.
        let (_, rows) = table_rows("rows_page_a", 10, 4).unwrap();
        assert_eq!(rows.into_iter().map(|row| row.values).collect::<Vec<_>>(), vec![vec![SqlValue::Integer(5)]]);

        commit_database(&database, &empty);
    }

    #[test]
    fn table_rows_rejects_an_unknown_table() {
        assert!(table_rows("does_not_exist", 10, 0).is_err());
    }

    #[test]
    fn durable_index_serves_equality_query_view() {
        let empty = Database::new();
        let (database, _) = engine::apply(
            &empty,
            "CREATE TABLE stable_index_test (id INT PRIMARY KEY, label TEXT)",
        )
        .unwrap();
        let (database, _) = engine::apply(
            &database,
            "INSERT INTO stable_index_test VALUES (1, 'one'), (2, 'two')",
        )
        .unwrap();
        commit_database(&empty, &database);
        let filtered = load_database_for_query("SELECT * FROM stable_index_test WHERE id = 2");
        let table = &filtered.tables["stable_index_test"];
        assert_eq!(table.rows.len(), 1);
        assert_eq!(
            table.rows.values().next().unwrap().values[1],
            SqlValue::Text("two".into())
        );
        let (updated, _) = engine::apply(
            &database,
            "UPDATE stable_index_test SET id = 3 WHERE id = 2",
        )
        .unwrap();
        commit_database(&database, &updated);
        assert!(
            load_database_for_query("SELECT * FROM stable_index_test WHERE id = 2").tables
                ["stable_index_test"]
                .rows
                .is_empty()
        );
        assert_eq!(
            load_database_for_query("SELECT * FROM stable_index_test WHERE id = 3").tables
                ["stable_index_test"]
                .rows
                .len(),
            1
        );
        commit_database(&updated, &empty);
    }

    #[test]
    fn config_and_permissions_are_stable_structures_too() {
        let principal = Principal::from_slice(&[42; 10]);
        let config = Config {
            auth_canister: Some(principal),
        };
        set_config(config.clone());
        set_permission(principal, PermissionLevel::ReadOnly);

        assert_eq!(get_config(), config);
        assert_eq!(get_permission(&principal), Some(PermissionLevel::ReadOnly));
        assert!(list_permissions().contains(&(principal, PermissionLevel::ReadOnly)));

        remove_permission(&principal);
        set_config(Config::default());
    }

    #[test]
    fn shared_permission_store_maps_database_access_to_the_legacy_stable_acl() {
        let principal = Principal::from_slice(&[43; 10]);
        PermissionStorage::set(PermissionEntry {
            module: crate::DATABASE_PERMISSION_MODULE.to_string(),
            principal,
            access: Access::Admin,
        })
        .unwrap();

        assert_eq!(get_permission(&principal), Some(PermissionLevel::ReadWrite));
        assert_eq!(
            PermissionStorage::get(crate::DATABASE_PERMISSION_MODULE, &principal),
            Some(Access::Write)
        );
        assert_eq!(
            PermissionStorage::list(Some(crate::DATABASE_PERMISSION_MODULE)),
            vec![PermissionEntry {
                module: crate::DATABASE_PERMISSION_MODULE.to_string(),
                principal,
                access: Access::Write,
            }]
        );
        assert!(PermissionStorage::set(PermissionEntry {
            module: "storage".to_string(),
            principal,
            access: Access::Read,
        })
        .is_err());

        PermissionStorage::remove(crate::DATABASE_PERMISSION_MODULE, &principal).unwrap();
    }

    #[test]
    fn rls_policies_are_stored_separately() {
        let policy = RlsPolicy {
            table_name: "stable_rls_test".to_string(),
            owner_column: "owner_id".to_string(),
        };
        set_rls_policy(policy.clone());
        assert_eq!(get_rls_policy("STABLE_RLS_TEST"), Some(policy.clone()));
        assert!(list_rls_policies().contains(&policy));
        remove_rls_policy("stable_rls_test");
        assert_eq!(get_rls_policy("stable_rls_test"), None);
    }

    #[test]
    fn old_table_metadata_decodes_with_empty_constraints() {
        #[derive(Serialize)]
        struct PreviousTableMeta {
            name: String,
            next_row_id: u64,
            row_count: u64,
        }
        let bytes = encode(&PreviousTableMeta {
            name: "legacy".to_string(),
            next_row_id: 2,
            row_count: 1,
        });
        let decoded: TableMeta = decode(&bytes);
        assert_eq!(decoded.name, "legacy");
        assert_eq!(decoded.constraints, RelationalConstraints::default());
        assert!(!decoded.index_ready);
    }
}
