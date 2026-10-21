// Direct browser-to-`ic-sql` table/row access - ported from
// `frontend/src/lib/database.ts`, trimmed to this app's one fixed canister
// (see `canisterId.ts`/`icSqlActor.ts`): every function here drops the
// `canisterId`/`network` parameters the dashboard's multi-canister version
// needed, since there both existed. `listDatabaseCanisters`/
// `databaseSubKind`/`DatabaseCanister` are gone entirely too - this app
// never resolves "which canister", only "which table".
//
// The SQL-safety logic below (`isValidSqlIdentifier`/`sqlLiteral`/
// `validateColumns`/`whereClause`) is unchanged from the original - still
// needed to build correct SQL text from a caller-ish table/column name
// before calling `execute`/`query`, though (as the original's own doc
// comment notes) it's not a security boundary: `ic-sql::execute` is a
// public method with no caller check of its own.

import { getIcSqlActor } from "./icSqlActor";
import type { QueryResult, SqlValue } from "./candid/icSql";

export interface TableColumn {
  name: string;
  data_type: string;
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: TableColumn[];
  error?: string;
}

export interface DatabaseTables {
  tables?: TableInfo[];
  error?: string;
}

export type SqlCell = string | null;

export interface TableRows {
  columns: string[];
  rows: SqlCell[][];
  rows_affected: number;
  message: string;
}

export type RowValues = Record<string, SqlCell>;

export interface WriteResult {
  rows_affected: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Ported from `orchestrator::routes::database` (via `frontend/src/lib/
// database.ts`) - see this file's own doc comment above.
// ---------------------------------------------------------------------------

export function isValidSqlIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/** Renders one submitted cell value as a SQL literal safe to embed in
 * generated SQL text - a `data_type` that looks numeric is only ever
 * emitted bare if the value itself actually parses as a number/`true`/
 * `false`; anything else always goes through single-quote escaping, so a
 * mismatched `data_type` can never turn arbitrary text into unquoted SQL. */
export function sqlLiteral(value: SqlCell, dataType: string): string {
  if (value === null) return "NULL";
  const dt = dataType.toUpperCase();
  const looksNumeric = ["INT", "REAL", "FLOAT", "DOUBLE", "NUMERIC", "BOOL"].some((k) => dt.includes(k));
  if (looksNumeric) {
    const lower = value.toLowerCase();
    if (lower === "true") return "1";
    if (lower === "false") return "0";
    if (value.trim() !== "" && Number.isFinite(Number(value))) return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateColumns(values: RowValues, columnTypes: Record<string, string>): void {
  for (const col of Object.keys(values)) {
    if (!isValidSqlIdentifier(col) || !(col in columnTypes)) {
      throw new Error(`unknown column '${col}'`);
    }
  }
}

export function whereClause(criteria: RowValues, columnTypes: Record<string, string>): string {
  return Object.entries(criteria)
    .map(([col, val]) => `${col} = ${sqlLiteral(val, columnTypes[col] ?? "")}`)
    .join(" AND ");
}

function sqlValueToCell(v: SqlValue): SqlCell {
  if ("Null" in v) return null;
  if ("Text" in v) return v.Text;
  if ("Boolean" in v) return v.Boolean ? "true" : "false";
  if ("Float" in v) return String(v.Float);
  return String(v.Integer);
}

function adaptQueryResult(result: QueryResult): TableRows {
  return {
    columns: result.columns,
    rows: result.rows.map((row) => row.map(sqlValueToCell)),
    rows_affected: Number(result.rows_affected),
    message: result.message,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every table in this canister's database, with real row counts/columns -
 * direct `ic-sql::list_tables` + `describe_table` calls. */
export async function listDatabaseTables(): Promise<DatabaseTables> {
  try {
    const actor = await getIcSqlActor();
    const names = await actor.list_tables();
    const tables = await Promise.all(
      names.map(async (name): Promise<TableInfo> => {
        const result = await actor.describe_table(name);
        if ("Ok" in result) {
          return { name: result.Ok.name, row_count: Number(result.Ok.row_count), columns: result.Ok.columns };
        }
        return { name, row_count: 0, columns: [], error: result.Err };
      })
    );
    return { tables };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const MAX_ROWS_PER_PAGE = 500;
const DEFAULT_ROWS_PER_PAGE = 50;

/** Up to `limit` (default 50, capped at 500) rows of `table`, starting at
 * `offset` - via `ic-sql`'s controller-only `get_table_rows`, not a
 * `SELECT * FROM <table> LIMIT <n> OFFSET <m>` through `query`: no SQL
 * text to build or parse, no full-database load on the canister side (see
 * `packages/ic-sql/src/storage.rs::table_rows`'s own doc comment) - this
 * table-browser's own identity is always either a controller or it isn't,
 * so there's nothing to gain from going through the general permission/RLS
 * path `query` respects just to read a page of rows. */
export async function getTableRows(table: string, opts?: { limit?: number; offset?: number }): Promise<TableRows> {
  if (!isValidSqlIdentifier(table)) throw new Error("invalid table name");
  const actor = await getIcSqlActor();
  const limit = Math.min(opts?.limit ?? DEFAULT_ROWS_PER_PAGE, MAX_ROWS_PER_PAGE);
  const offset = opts?.offset ?? 0;
  const result = await actor.get_table_rows(table, BigInt(limit), BigInt(offset));
  if ("Err" in result) throw new Error(result.Err);
  return adaptQueryResult(result.Ok);
}

async function columnTypes(table: string): Promise<Record<string, string>> {
  const actor = await getIcSqlActor();
  const result = await actor.describe_table(table);
  if ("Err" in result) throw new Error(result.Err);
  return Object.fromEntries(result.Ok.columns.map((c) => [c.name, c.data_type]));
}

async function runExecute(sql: string): Promise<WriteResult> {
  const actor = await getIcSqlActor();
  const result = await actor.execute(sql);
  if ("Err" in result) throw new Error(result.Err);
  return { rows_affected: Number(result.Ok.rows_affected), message: result.Ok.message };
}

/** Inserts one row - a real `INSERT INTO table (cols...) VALUES (literals...)`
 * through `ic-sql`'s `execute`. */
export async function createRow(table: string, values: RowValues): Promise<WriteResult> {
  if (!isValidSqlIdentifier(table)) throw new Error("invalid table name");
  if (Object.keys(values).length === 0) throw new Error("values must not be empty");
  const types = await columnTypes(table);
  validateColumns(values, types);
  const columns = Object.keys(values);
  const literals = columns.map((c) => sqlLiteral(values[c], types[c]));
  return runExecute(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${literals.join(", ")})`);
}

/** Updates every row exactly matching `match` - `ic-sql` has no primary
 * key/rowid support, so "which row" always means "the row with exactly
 * these values" (see `match`'s own caveat: a duplicate row is
 * indistinguishable from the one you meant). */
export async function updateRow(table: string, match: RowValues, values: RowValues): Promise<WriteResult> {
  if (!isValidSqlIdentifier(table)) throw new Error("invalid table name");
  if (Object.keys(match).length === 0) throw new Error("match must not be empty - refusing to update every row");
  if (Object.keys(values).length === 0) throw new Error("values must not be empty");
  const types = await columnTypes(table);
  validateColumns(match, types);
  validateColumns(values, types);
  const setClause = Object.entries(values)
    .map(([col, val]) => `${col} = ${sqlLiteral(val, types[col])}`)
    .join(", ");
  return runExecute(`UPDATE ${table} SET ${setClause} WHERE ${whereClause(match, types)}`);
}

/** Deletes every row exactly matching `match` - same "full row as
 * identity" caveat as `updateRow`. */
export async function deleteRow(table: string, match: RowValues): Promise<WriteResult> {
  if (!isValidSqlIdentifier(table)) throw new Error("invalid table name");
  if (Object.keys(match).length === 0) throw new Error("match must not be empty - refusing to delete every row");
  const types = await columnTypes(table);
  validateColumns(match, types);
  return runExecute(`DELETE FROM ${table} WHERE ${whereClause(match, types)}`);
}
