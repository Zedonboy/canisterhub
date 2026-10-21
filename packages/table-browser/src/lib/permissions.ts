// Direct browser-to-`ic-sql` permission (ACL) management - the
// generic `canister_hub_sdk::permission_api!` surface every
// `permission_api!`-backed canister shares, mapped onto `ic-sql`'s own
// `PermissionLevel` (`Blocked`/`ReadOnly`/`ReadWrite`) - see
// `candid/icSql.ts`'s own doc comment on the `Access <-> PermissionLevel`
// mapping. `list_permissions`/`get_permission` are public reads; `set_
// permission`/`remove_permission` are controller-only on the real
// canister (`require_controller` inside the generated endpoints) - this
// module doesn't pre-check that itself, it just surfaces the canister's
// own real rejection if a non-controller tries.

import { Principal } from "@icp-sdk/core/principal";
import { getIcSqlActor } from "./icSqlActor";
import type { Access } from "./candid/icSql";

/** The only module `ic-sql` gates - `DATABASE_PERMISSION_MODULE` in
 * `packages/ic-sql/src/lib.rs`. */
const MODULE = "database";

export type PermissionLevel = "blocked" | "read_only" | "read_write";

export interface Permission {
  principal: string;
  level: PermissionLevel;
}

function accessToLevel(access: Access): PermissionLevel {
  if ("None" in access) return "blocked";
  if ("Read" in access) return "read_only";
  return "read_write";
}

function levelToAccess(level: PermissionLevel): Access {
  if (level === "blocked") return { None: null };
  if (level === "read_only") return { Read: null };
  return { Write: null };
}

/** Every explicit permission entry on this canister - a pure client-side
 * sort by principal text, for a stable display order. */
export async function listPermissions(): Promise<Permission[]> {
  const actor = await getIcSqlActor();
  const entries = await actor.list_permissions([MODULE]);
  return entries
    .map((entry) => ({ principal: entry.principal.toText(), level: accessToLevel(entry.access) }))
    .sort((a, b) => a.principal.localeCompare(b.principal));
}

/** Sets (or replaces) `principal`'s explicit level - throws with the
 * canister's own real rejection message (e.g. "only a controller may
 * change permissions") if the signed-in identity isn't allowed to. */
export async function setPermission(principal: string, level: PermissionLevel): Promise<void> {
  const actor = await getIcSqlActor();
  const result = await actor.set_permission({ principal: Principal.fromText(principal), module: MODULE, access: levelToAccess(level) });
  if ("Err" in result) throw new Error(result.Err);
}

/** Clears `principal`'s explicit entry, reverting them to this
 * canister's default (anonymous: read-only; any other caller:
 * read-write, unless an `auth_canister` is configured - see `auth.rs`'s
 * own doc comment). */
export async function removePermission(principal: string): Promise<void> {
  const actor = await getIcSqlActor();
  const result = await actor.remove_permission(MODULE, Principal.fromText(principal));
  if ("Err" in result) throw new Error(result.Err);
}
