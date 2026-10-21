# ic-sql

A small Internet Computer canister that behaves like a PostgreSQL-dialect
SQL database: `execute`/`query` take a SQL string and run it directly
against this canister's own persisted state. No connection, client
library, or schema migration tooling - a caller (human or another canister)
just sends SQL text and gets a structured result back.

## Methods

- **`execute(sql: text) -> Result<QueryResult, text>`** (update) - runs any
  statement: `CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE`, `DROP TABLE`, or
  `SELECT`. Use this for anything that changes state. Requires `ReadWrite`
  access - see "Authorization" below.
- **`query(sql: text) -> Result<QueryResult, text>`** (query, faster/cheaper
  - no consensus round) - runs a read-only `SELECT` only. Passing anything
  else returns an error immediately (an IC query call's state changes are
  never committed anyway, so this rejects a mutation outright rather than
  silently discarding it). Allowed for `ReadOnly` and `ReadWrite` callers.
- **`list_tables() -> vec text`** (query)
- **`describe_table(table_name: text) -> Result<TableDescription, text>`**
  (query) - columns and row count for one table. Call this (or
  `list_tables`) before writing SQL against a table whose schema you don't
  already know - there's no other way to discover it.
- **`describe_constraints(table_name) -> Result<ConstraintDescription, text>`**
  (query) - enforced scalar defaults, NOT NULL, primary-key, unique,
  foreign-key, CHECK, and index metadata.
- **`execute_batch(statements) -> Result<vec QueryResult, text>`** (update) -
  up to 100 statements/1 MiB of SQL as one atomic unit. Nothing reaches stable
  storage unless every statement succeeds. `execute_batch_with_session` is the
  OAuth-session equivalent.
- **`http_request` / `http_request_update`** - PostgREST-style JSON access at
  `/rest/v1/{table}`. GET/HEAD supports `select`, `order`, `limit`, `offset`, and column
  filters using `eq`, `neq`, `gt`, `gte`, `lt`, or `lte`. POST accepts a JSON
  object or array; PATCH accepts a JSON object; DELETE uses the same filters.
  Send `Prefer: return=representation` to receive affected JSON rows.

Raw HTTP gateway requests are anonymous. On tables without RLS, reads are
read-only by default and writes return 403 unless a controller explicitly
grants principal `2vxsx-fae` `ReadWrite`; such a grant makes those writes
public. RLS tables instead require and validate a bearer session.

## Row-level security

RLS is enabled per table by a controller with
`enable_rls(table_name, owner_column)`. The owner column must have a text type,
and `Config.auth_canister` must already be configured. Policies live in their
own stable map and are removed automatically when their table is dropped.

The canonical row subject is `profile:<profile_id>`, where `profile_id` is the
value returned by the configured auth canister. Candid callers are resolved via
`authorize_principal`; REST bearer sessions and the session-token Candid methods
are resolved via `authorize_session`. Never accept a caller-supplied user id.

For a protected table, INSERT injects the subject into the owner column and
rejects a conflicting value. SELECT, UPDATE, and DELETE consider only rows with
that owner. UPDATE cannot transfer ownership. Existing rows with null or legacy
owner values are invisible after RLS is enabled.

Opaque bearer validation requires an inter-canister call, so protected REST
GET/HEAD calls upgrade to `http_request_update`. The ordinary Candid `query`
rejects protected-table access for non-controller callers; use the update method
`query_authenticated`, or `query_with_session` for an OAuth-only identity.
Controllers bypass RLS for migrations and administration.

`QueryResult` is `{ columns: vec text; rows: vec vec SqlValue; rows_affected:
nat64; message: text }`. `SqlValue` is one of `Null | Integer(int64) |
Float(float64) | Text(text) | Boolean(bool)`.

## What SQL is actually supported

This is a real but deliberately small SQL engine, not a full RDBMS. SQL text
is parsed with **PostgreSQL's own dialect rules** (`sqlparser`'s
`PostgreSqlDialect`) - Postgres-specific syntax parses correctly, but the
engine itself only *executes* the following:

- `CREATE TABLE name (col type [DEFAULT literal] [NOT NULL|UNIQUE|PRIMARY KEY], ...,
  [UNIQUE (...)] [PRIMARY KEY (...)] [FOREIGN KEY (...) REFERENCES ...]
  [CHECK (...)])`.
  Types are enforced. Supported families are integer, numeric/float, boolean,
  and text-like (`TEXT`/character, UUID, date/time and JSON values currently
  use text representation). Foreign keys support `NO ACTION`, `RESTRICT`,
  `CASCADE`, `SET NULL`, and `SET DEFAULT` for updates and deletes.
- `CREATE [UNIQUE] INDEX name ON table (columns...)` and `DROP INDEX name`. Definitions and physical
  row-key entries are durable; simple indexed equality reads use them.
- Bounded `ALTER TABLE`: add/drop/rename columns, set/drop defaults and NOT
  NULL, and add/drop named CHECK/UNIQUE/PRIMARY/FOREIGN KEY constraints.
- `INSERT INTO name [(cols...)] VALUES (...), (...)`
- `SELECT [*|col [AS alias], ...] FROM name [INNER|LEFT JOIN ... ON|USING ...]
  [WHERE cond]
  [ORDER BY col [ASC|DESC] [NULLS FIRST|LAST]] [LIMIT n] [OFFSET n]` - one
  base table with bounded INNER, LEFT, or CROSS joins.
- `GROUP BY` with `COUNT`, `SUM`, `AVG`, `MIN`, and `MAX`.
- `UPDATE name SET col = val, ... [WHERE cond]`
- `DELETE FROM name [WHERE cond]`
- `DROP TABLE name` through the canister boundary (one at a time so RLS and
  foreign-key policy resolution remains unambiguous).
- A `WHERE`/condition can combine comparisons (`=`, `!=`/`<>`, `<`, `>`,
  `<=`, `>=`) with `AND`/`OR` and parentheses.

**Not supported at all** - these are rejected rather than deliberately
implemented as partial behavior:
- `HAVING`, `DISTINCT`, RIGHT/FULL/NATURAL joins, and aggregates over joins.
- Partial/expression indexes, unbounded schema rewrites, ALTER COLUMN type
  conversion, subqueries, `UNION`,
  Postgres-specific type casts (`::`) and functions. Use `execute_batch`
  rather than concatenating multiple statements into one SQL string.

If you need one of the unsupported features, compute it client-side from a
plain `SELECT *` - don't write SQL that assumes it works.

## Architecture (why results are exactly reproducible)

The query engine (`src/engine.rs`) is a pure, side-effect-free "functional
core": `apply(db, sql)` is a deterministic function from one immutable
in-memory `Database` value to the next - the same `db` and `sql` always
produce the same result, and a "write" never mutates the database it was
given, only returns a new one. This is also why every statement is atomic:
`DROP TABLE a, b` where `b` doesn't exist leaves `a` untouched rather than
partially applying.

## Persistence and its limit

Tables, the table-name index, columns, rows, and physical index entries are stored in separate
`ic_stable_structures::StableBTreeMap`s. Rows have composite
`(table_id, row_id)` keys, while counters/config use `StableCell` and
permissions use another stable map. Writes commit changed rows directly to
stable memory; upgrades do not serialize the database through
`pre_upgrade`. SQL execution still materializes an in-memory view for the
small pure engine, so very broad scans remain bounded by per-message heap and
instruction limits even though durable storage itself is upgrade-safe and
incremental.

## Authorization

Every caller resolves to one of three levels before `execute`/`query` runs
any SQL at all:

- **`Blocked`** - no calls at all, neither `execute` nor `query`.
- **`ReadOnly`** - `query` works; `execute` is rejected outright, even for a
  harmless `SELECT` (`execute` is the read-*write* endpoint - use `query`
  for reads).
- **`ReadWrite`** - both, no restriction.

How a caller's level is decided, in order:
1. An explicit entry set for that principal via `set_permission` always
   wins, including for the anonymous principal.
2. Otherwise, the anonymous principal (an unauthenticated/public caller) is
   always `ReadOnly`.
3. Otherwise, if no `auth_canister` is configured (`Config.auth_canister`,
   `None` by default), the caller is `ReadWrite` - the same
   no-access-control behavior this canister always had.
4. Otherwise, this canister calls the configured `auth` canister's
   `authorize_principal` query with the caller's principal. A recognized
   identity (`Some(Authorization)`) gets `ReadWrite`; an unrecognized one
   (`None`, or the call itself failing) gets `ReadOnly` - an unreachable or
   misconfigured `auth` canister can only ever narrow access, never grant it.

Permission mutations and configuration management are controller-only;
permission reads are public:
- **`set_permission(PermissionEntry) -> Result<(), text>`** (update), using
  module `database` and access `None`, `Read`, `Write`, or `Admin`.
- **`remove_permission(module, principal) -> Result<(), text>`** (update) - clears
  the explicit entry, reverting to the default above.
- **`get_permission(module, principal) -> opt Access`** (query)
- **`list_permissions(module: opt text) -> vec PermissionEntry`** (query)
- **`update_config(ConfigUpdate) -> Result<(), text>`** (update) - sets or
  updates `auth_canister` through the compatibility API.
- **`get_database_config() -> Result<Config, text>`** (query)
- **`get_config_schema` / `get_config` / `set_config`** - the standard
  dynamic module configuration surface used by the marketplace UI.

`Config` has one field, `auth_canister: opt principal`. The canister's
no-argument init hook opens its stable dynamic-config store; configure the
auth reference after deploy.

## Using this from another canister

Call `execute`/`query` like any other canister method (candid, one `text`
argument) - the caller's own principal (`msg_caller`) is what the
authorization model above checks, so there's nothing extra to pass.

## Candid interface

- `llm_context() -> text` (query, open to any caller) - this document.

See `ic-sql.did` for the exact types.
