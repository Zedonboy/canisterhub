# ic-sql

An Internet Computer canister that behaves like a small PostgreSQL-dialect
SQL database: `execute`/`query` take a SQL string and run it directly
against the canister's own state - no client library, connection, or
schema-migration tooling required. SQL text is parsed with `sqlparser`'s
`PostgreSqlDialect`. It supports relational constraints, bounded schema
changes, durable indexes, joins, grouping/aggregates, and atomic batches in
addition to ordinary CRUD.

## A *functional* SQL database

The query engine (`src/engine.rs`) is a pure, side-effect-free "functional
core": every SQL statement is executed as a deterministic transformation
from one immutable `Database` value to the next -

```rust
pub fn apply(db: &Database, sql: &str) -> Result<(Database, QueryResult), String>
```

Given the same `db` and the same `sql`, `apply` always returns the same
result, and never modifies the `db` it was given - a "mutation" is just
`apply` handing back a *new* `Database` value, built from the old one, which
is left exactly as it was. Nothing in `engine.rs` touches a `thread_local`,
calls into `ic_cdk`, or reads any other hidden state - which is what makes it
fully testable with plain `cargo test`, no canister runtime or Wasm build
required (see "Testing" below). The same is true of `src/auth.rs`'s
`decide` function - see "Authorization" below.

`Database`/`Table` are backed by [`im`](https://docs.rs/im)'s persistent
(structurally-shared) maps rather than `std::collections::BTreeMap`, so this
isn't "clone the whole database on every write" - inserting a row or
dropping a table is `O(log n)` and shares all unaffected structure with the
original.

One concrete benefit worth calling out: this makes every statement atomic
for free. `DROP TABLE a, b` where `b` doesn't exist can't leave `a` dropped
either way - each statement builds its *entire* new `Database` before
returning `Ok`, so an error partway through means the function returns
before constructing (let alone committing) any new value at all.

`src/lib.rs` is the thin imperative shell around that core. It loads a view
from `src/storage.rs`, calls `engine::apply`, then commits only the changed
stable records after a successful statement.

## Persistence

Durable state is written directly through `ic-stable-structures`:

- table metadata: `StableBTreeMap<table_id, TableMeta>`
- table-name index: `StableBTreeMap<name, table_id>`
- columns: `StableBTreeMap<(table_id, position), ColumnDef>`
- rows: `StableBTreeMap<(table_id, row_id), Row>`
- the table-ID counter and configuration: `StableCell`
- permissions: `StableBTreeMap<principal, PermissionLevel>`, exposed through
  the shared module-scoped SDK ACL as module `database`
- physical index entries: `StableBTreeMap<(table_id, index, key, row_id), _>`

Composite row keys keep each table's rows contiguous without consuming a
new stable-memory region for every table. There is no whole-database
`pre_upgrade` serialization step; stable structures reopen themselves after
an upgrade. The first upgrade from the former snapshot-based release detects
and migrates that legacy snapshot into the new maps. A SQL call still
materializes the current database view for the pure engine, so query execution
itself remains intentionally small-engine rather than full PostgreSQL-scale.

## Authorization

`src/auth.rs`'s `decide` function is the whole model, in one pure decision
function: given (1) an optional explicit local permission entry for the
caller, (2) the caller's own principal, and (3) an optional "did the
configured `auth` canister recognize this caller" lookup, it returns exactly
one of `Blocked` / `ReadOnly` / `ReadWrite`. In order:

1. An explicit `set_permission` entry for module `database` always wins outright
   - including one set for the anonymous principal.
2. With no explicit entry, the anonymous principal is always `ReadOnly`
   (the "public user" scenario this feature was built for).
3. With no explicit entry and a non-anonymous caller: `ReadWrite` if no
   `auth_canister` is configured (`Config.auth_canister`, `None` by
   default - the same no-access-control behavior this canister always had);
   otherwise this canister calls that `auth` canister's `authorize_principal`
   query and uses `ReadWrite` if it recognizes the caller, `ReadOnly`
   otherwise (a failed/unreachable call is treated the same as "not
   recognized" - it can only narrow access, never grant it).

`execute` (this canister's read-*write* endpoint) requires `ReadWrite` and
rejects `Blocked`/`ReadOnly` callers outright, regardless of which statement
they sent. `query` is already structurally read-only, so it only rejects
`Blocked` callers.

Permission management (`set_permission`/`remove_permission`/
`list_permissions`) and compatibility config (`get_database_config`/`update_config`, currently
just `auth_canister`) are all controller-only.

## API

### `execute(sql: text) -> Result<QueryResult, text>` (update)

Runs any statement - DDL (`CREATE TABLE`/`DROP TABLE`) or DML
(`INSERT`/`UPDATE`/`DELETE`/`SELECT`) - and persists its effect. Requires
`ReadWrite` access (see "Authorization").

### `query(sql: text) -> Result<QueryResult, text>` (query)

Runs a read-only `SELECT` without going through consensus. Rejects anything
else outright: an IC query call's state changes are never committed
regardless, so letting a mutation through here would silently discard it
instead of reporting an error. Allowed for `ReadOnly` and `ReadWrite`
callers.

### `execute_batch(statements: vec text) -> Result<vec QueryResult, text>` (update)

Executes up to 100 statements (at most 1 MiB of SQL) atomically. Every
statement runs against the preceding statement's result in memory; stable
storage is updated only after all statements, constraints, permissions, and
RLS checks succeed. `execute_batch_with_session` provides the bearer-session
equivalent.

### `list_tables() -> vec text` (query)

### `describe_table(table_name: text) -> Result<TableDescription, text>` (query)

### `describe_constraints(table_name: text) -> Result<ConstraintDescription, text>` (query)

Returns enforced scalar defaults, `NOT NULL`, `PRIMARY KEY`, `UNIQUE`,
`FOREIGN KEY`, `CHECK`, and index metadata without changing the existing
`describe_table` wire shape.

The SQL subset includes `CREATE [UNIQUE] INDEX`/`DROP INDEX`, bounded `ALTER TABLE` for
adding/dropping/renaming columns and common constraints/defaults, INNER/LEFT
joins, `GROUP BY`, and `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`. Foreign keys support
`NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, and `SET DEFAULT` on updates
and deletes. Schema rewrites and cascading actions are capped at 10,000 rows;
join intermediates are capped at 100,000 rows. Unsupported variants return an
error atomically. `HAVING`, RIGHT/FULL/NATURAL joins, partial/expression
indexes, and ALTER COLUMN type conversion are not yet supported.

### PostgREST-style HTTP API

The canister implements the IC HTTP Gateway's `http_request` and
`http_request_update` interface and exposes collection routes at
`/rest/v1/{table}`:

```sh
# Read rows. Supported filters: eq, neq, gt, gte, lt, lte.
curl 'https://<canister-id>.icp0.io/rest/v1/users?select=id,name&id=gte.10&order=name.asc&limit=50&offset=0'

# Insert one object or an array of objects.
curl -X POST 'https://<canister-id>.icp0.io/rest/v1/users' \
  -H 'content-type: application/json' \
  -H 'prefer: return=representation' \
  -d '{"id": 11, "name": "alice"}'

# Update or delete matching rows.
curl -X PATCH 'https://<canister-id>.icp0.io/rest/v1/users?id=eq.11' \
  -H 'content-type: application/json' -d '{"name": "Alice"}'
curl -X DELETE 'https://<canister-id>.icp0.io/rest/v1/users?id=eq.11'
```

`GET`, `HEAD`, and CORS `OPTIONS` are supported. `POST`, `PATCH`, and
`DELETE` are upgraded to consensus-backed update calls. Responses use JSON,
PostgREST-shaped error objects, `Content-Range`, and
`Prefer: return=representation`. Pages default to 100 rows and are capped at
500; request bodies are capped at 1 MiB.

Raw HTTP gateway calls have the anonymous principal. Reads therefore use the
existing anonymous permission (read-only by default). REST writes are disabled
until a controller explicitly grants the anonymous principal `ReadWrite`:

```sh
icp canister call ic-sql set_permission \
  '(principal "2vxsx-fae", variant { ReadWrite })'
```

That grant makes the unprotected REST write surface public. On tables without
RLS, `Authorization` and `apikey` headers are compatibility headers and do not
authenticate a user. Keep anonymous access `ReadOnly`, or enable RLS to require
a verified bearer session.

### Row-level security

RLS is opt-in per table and uses an auth profile id as the canonical user
identity across both IC principals and bearer sessions. Create a text ownership
column, configure the sibling `auth` canister, then enable the policy:

```sql
CREATE TABLE documents (id INT, owner_id TEXT, title TEXT)
```

```sh
icp canister call ic-sql update_config \
  '(record { auth_canister = opt opt principal "<auth-canister-id>" })'
icp canister call ic-sql enable_rls '("documents", "owner_id")'
```

The database stores owners as `profile:<auth-profile-id>`. It injects that value
on insert, filters SELECT/UPDATE/DELETE to matching rows, and rejects ownership
reassignment. Client-supplied user ids are never trusted. Existing rows whose
owner column is null or does not match a valid profile key become invisible, so
backfill that column before enabling RLS.

REST requests to an RLS table require `Authorization: Bearer <session-token>`.
Protected GET/HEAD requests are upgraded to consensus-backed update calls so the
opaque session can be checked through `auth.authorize_session` before reading.
Native IC callers use `query_authenticated(sql)` and `execute(sql)`, which map
`msg_caller()` through `auth.authorize_principal`. OAuth-only clients can use
`query_with_session(token, sql)` and `execute_with_session(token, sql)`. All four
paths resolve to the same profile id.

Controllers have an explicit administrative RLS bypass. Other callers cannot
perform schema changes through an RLS policy; disable the policy as a controller
before dropping or migrating a protected table. Policy configuration is stable
across upgrades and available through `enable_rls`, `disable_rls`, and
`list_rls_policies`. Protected `describe_table` metadata, including its global
row count, is controller-only.

### `set_permission(PermissionEntry) -> Result<(), text>` (update, controller-only)

`PermissionEntry` is `{ module = "database"; principal; access }`, where
`access` is `None`, `Read`, `Write`, or `Admin`. `Admin` currently implies
database read/write; ACL mutations remain controller-only.

### `remove_permission(module, principal) -> Result<(), text>` (update, controller-only)

### `get_permission(module, principal) -> opt Access` (query)

### `list_permissions(module: opt text) -> vec PermissionEntry` (query)

### `update_config(ConfigUpdate) -> Result<(), text>` (update, controller-only)

### `get_database_config() -> Result<Config, text>` (query, controller-only)

### `get_config_schema()` / `get_config()` / `set_config(...)`

Standard dynamic module configuration. Its schema exposes `auth_canister` as
an optional picker filtered to auth modules; `set_config` is controller-only.

### `llm_context() -> text` (query, open to any caller)

A prose description of this canister for an AI agent (or a human) to
consume: what it does, exactly which SQL it supports (and, just as
important, which clauses remain unsupported), its persistence tradeoffs, and the
authorization model. Served from `src/llm_context.md` via `include_str!`,
so it's always in sync with what's actually committed there.

`QueryResult { columns: vec text; rows: vec vec SqlValue; rows_affected: nat64; message: text }`.
`SqlValue` is one of `Null`, `Integer(int64)`, `Float(float64)`, `Text(text)`,
`Boolean(bool)`. ACL access is one of `None`, `Read`, `Write`, or `Admin`.
See `ic-sql.did` for the exact Candid types.

## Example

```sh
icp canister call ic-sql execute '("CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, active BOOLEAN)")'
icp canister call ic-sql execute '("INSERT INTO users (id, name, active) VALUES (1, '"'"'alice'"'"', true)")'
icp canister call ic-sql query '("SELECT * FROM users WHERE active = true")'

# Block a caller entirely, or cap one to read-only:
icp canister call ic-sql set_permission '(principal "aaaaa-aa", variant { Blocked })'
icp canister call ic-sql set_permission '(principal "aaaaa-aa", variant { ReadOnly })'

# Point at an `auth` canister so unrecognized callers default to read-only:
icp canister call ic-sql update_config '(record { auth_canister = opt opt principal "aaaaa-aa" })'
```

## Regenerating `ic-sql.did`

Hand-committed, not auto-generated at build time - matches this repo's other
canisters' convention.

```sh
cargo build --target wasm32-unknown-unknown --release
candid-extractor ../target/wasm32-unknown-unknown/release/ic_sql.wasm > ic-sql.did
```

(Cargo compiles the package's hyphenated name `ic-sql` to the Wasm file
`ic_sql.wasm` - ordinary Rust crate-name mangling, not a typo.)

## Testing

```sh
cargo test --lib   # engine.rs's + auth.rs's pure-core unit tests - no Wasm build needed
cargo build --target wasm32-unknown-unknown --release
cargo test          # + tests/ic_sql_tests.rs's PocketIC integration tests
```

`cargo test --lib` covers the query engine and the authorization decision
logic directly and exhaustively: every SQL statement kind, error paths
(missing table, duplicate table, column-count mismatch), `WHERE` with
`AND`/`OR`, the atomicity guarantee on a multi-table `DROP TABLE`, an
explicit check that `apply` never mutates the `Database` it was given, a
round-trip through the separate stable catalog/column/row maps, and every branch of `auth::decide`
(explicit entries winning outright, the anonymous default, and both
outcomes of an `auth` canister lookup).

`tests/ic_sql_tests.rs` (real PocketIC, not a stub - set `POCKET_IC_BIN` to
a local server binary to avoid a download on first run) exercises the actual
canister interface end to end - `execute`/`query`/`list_tables`/
`describe_table` over Candid, the two authorization scenarios (a blocked
caller rejected on both endpoints; the anonymous principal allowed to
`query` but not `execute`), controller gating on `set_permission`/
`update_config`/`get_config`, and that both the database and the permission
table survive a real `pic.upgrade_canister` call.
