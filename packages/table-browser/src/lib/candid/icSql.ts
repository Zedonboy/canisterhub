// Hand-written mirror of `packages/ic-sql/ic-sql.did` - ported verbatim
// from `frontend/src/lib/candid/icSql.ts`. Every method here is exactly
// what `ic-sql` itself exposes; the SQL-safety logic that builds safe
// statements before calling `execute`/`query` lives in
// `frontend/src/lib/database.ts`, not here.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export type SqlValue = { Null: null } | { Text: string } | { Boolean: boolean } | { Float: number } | { Integer: bigint };

/** `canister_hub_sdk::permissions::Access` - the generic ACL level every
 * `permission_api!`-backed canister shares. `ic-sql` maps this onto its
 * own `PermissionLevel` (`auth.rs`): `None` -> `Blocked`, `Read` ->
 * `ReadOnly`, `Write`/`Admin` -> `ReadWrite` - see
 * `storage.rs`'s own doc comment on that mapping. `Admin` behaves
 * identically to `Write` for this canister, so the UI never offers it as
 * a distinct choice. */
export type Access = { None: null } | { Read: null } | { Write: null } | { Admin: null };

/** `module` is always `"database"` here (`DATABASE_PERMISSION_MODULE` in
 * `lib.rs`) - `ic-sql` only has the one kind of access to gate. */
export interface PermissionEntry {
  principal: Principal;
  module: string;
  access: Access;
}

export interface ColumnDef {
  name: string;
  data_type: string;
}

export interface TableDescription {
  name: string;
  row_count: bigint;
  columns: ColumnDef[];
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
  rows_affected: bigint;
  message: string;
}

export interface IcSqlService {
  list_tables: () => Promise<string[]>;
  describe_table: (table: string) => Promise<{ Ok: TableDescription } | { Err: string }>;
  query: (sql: string) => Promise<{ Ok: QueryResult } | { Err: string }>;
  execute: (sql: string) => Promise<{ Ok: QueryResult } | { Err: string }>;
  /** Controller-only fast path - no SQL text, no parser, no full-database
   * load (see `packages/ic-sql/src/storage.rs::table_rows`'s own doc
   * comment). What `database.ts::getTableRows` calls instead of building
   * `SELECT * FROM table LIMIT n OFFSET m` and sending it through `query`. */
  get_table_rows: (table: string, limit: bigint, offset: bigint) => Promise<{ Ok: QueryResult } | { Err: string }>;
  llm_context: () => Promise<string>;
  /** Public read - every entry for `module` (always `"database"` here),
   * or every module's if omitted (never needed here). */
  list_permissions: (module: [] | [string]) => Promise<PermissionEntry[]>;
  get_permission: (module: string, principal: Principal) => Promise<[] | [Access]>;
  /** Controller-only - rejects with a real error for anyone else. */
  set_permission: (entry: PermissionEntry) => Promise<{ Ok: null } | { Err: string }>;
  remove_permission: (module: string, principal: Principal) => Promise<{ Ok: null } | { Err: string }>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const SqlValue = IDL.Variant({ Null: IDL.Null, Text: IDL.Text, Boolean: IDL.Bool, Float: IDL.Float64, Integer: IDL.Int64 });
  const ColumnDef = IDL.Record({ name: IDL.Text, data_type: IDL.Text });
  const TableDescription = IDL.Record({ name: IDL.Text, row_count: IDL.Nat64, columns: IDL.Vec(ColumnDef) });
  const QueryResult = IDL.Record({ rows: IDL.Vec(IDL.Vec(SqlValue)), rows_affected: IDL.Nat64, message: IDL.Text, columns: IDL.Vec(IDL.Text) });
  const DescribeResult = IDL.Variant({ Ok: TableDescription, Err: IDL.Text });
  const QueryOrExecResult = IDL.Variant({ Ok: QueryResult, Err: IDL.Text });
  const Access = IDL.Variant({ None: IDL.Null, Read: IDL.Null, Write: IDL.Null, Admin: IDL.Null });
  const PermissionEntry = IDL.Record({ access: Access, principal: IDL.Principal, module: IDL.Text });
  const UnitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return IDL.Service({
    describe_table: IDL.Func([IDL.Text], [DescribeResult], ["query"]),
    execute: IDL.Func([IDL.Text], [QueryOrExecResult], []),
    get_permission: IDL.Func([IDL.Text, IDL.Principal], [IDL.Opt(Access)], ["query"]),
    get_table_rows: IDL.Func([IDL.Text, IDL.Nat64, IDL.Nat64], [QueryOrExecResult], ["query"]),
    list_permissions: IDL.Func([IDL.Opt(IDL.Text)], [IDL.Vec(PermissionEntry)], ["query"]),
    list_tables: IDL.Func([], [IDL.Vec(IDL.Text)], ["query"]),
    llm_context: IDL.Func([], [IDL.Text], ["query"]),
    query: IDL.Func([IDL.Text], [QueryOrExecResult], ["query"]),
    remove_permission: IDL.Func([IDL.Text, IDL.Principal], [UnitResult], []),
    set_permission: IDL.Func([PermissionEntry], [UnitResult], []),
  });
};
