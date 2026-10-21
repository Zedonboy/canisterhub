// Which `database`-kind canister on a project is which real building
// block - used by `lib/agentMap.ts` to let an agent be wired to a
// database node. The table/row browsing + CRUD that used to live here
// (`listDatabaseTables`/`getTableRows`/`createRow`/`updateRow`/
// `deleteRow`, and the SQL-safety builders they needed) moved out to the
// standalone `packages/table-browser` app, embedded directly into
// `ic-sql`'s own wasm and reached from the dashboard via the "View data"
// icon on a canister's card (see `Overview.tsx` and
// `pages/CanisterViewData.tsx`) - this file no longer talks to any
// canister at all, just classifies names already in hand.

import type { Project, CanisterKind } from "./backend";

export type DatabaseKind = "sql" | "kv" | "vector";

export interface DatabaseCanister {
  name: string;
  id: string;
  kind: DatabaseKind | "unknown";
}

/** Which of the three real database building blocks a canister actually
 * is, inferred from its name - direct port of
 * `orchestrator::routes::database::database_sub_kind`. Prefix-matched, not
 * exact-matched, so a second `ic-sql` deployed via
 * `deployDatabase`/`free_canister_name`'s own numbering (`ic-sql-2`, ...)
 * is still recognized as `"sql"`. */
function databaseSubKind(name: string): DatabaseKind | "unknown" {
  if (name.startsWith("ic-sql") || name.startsWith("ic_sql")) return "sql";
  if (name.startsWith("ic-kv") || name.startsWith("ic_kv")) return "kv";
  if (name.startsWith("vector_db") || name.startsWith("vector-db")) return "vector";
  return "unknown";
}

/** Every `Database`-kind canister on this project - a pure client-side
 * filter of `Project.canisters` (already fetched from `backend` - see
 * `lib/backend.ts`), no canister call needed. */
export function listDatabaseCanisters(project: Project): DatabaseCanister[] {
  return Object.entries(project.canisters)
    .filter(([, info]: [string, { kind: CanisterKind }]) => info.kind === "database")
    .map(([name, info]) => ({ name, id: info.id, kind: databaseSubKind(name) }));
}
