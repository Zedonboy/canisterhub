// Real, direct-to-IC log tail for one canister - the read side of the
// management canister's `fetch_canister_logs` (see
// `candid/management.ts`'s own doc comment for the call itself). What
// comes back is the canister's own debug buffer (its `debug_print!`
// output, traps, etc.) - raw text lines, capped and ordered by the IC
// itself (`idx` is the per-canister sequence number). Whether a caller
// may read them is governed by the target's `log_visibility` setting
// (controllers-only by default) - this dashboard's signed-in identity
// controls its own project's canisters (see `canisterStats.ts`'s own doc
// comment), so this succeeds for them and is expected to fail for
// anything it doesn't control.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";

export interface RawCanisterLogRecord {
  idx: bigint;
  /** Nanoseconds since the Unix epoch. */
  timestamp: bigint;
  /** The record's raw bytes decoded as UTF-8. */
  text: string;
}

/** One canister's current log tail, oldest first. Throws on rejection
 * (visibility/permissions, unreachable canister) - callers treat one
 * canister's failure as that canister's own status, never as a
 * page-wide error, matching `canisterStats.ts`'s best-effort convention. */
export async function fetchCanisterLogTail(id: string, network: string): Promise<RawCanisterLogRecord[]> {
  const agent = await getAgent(network);
  const canisterId = Principal.fromText(id);
  const actor = Actor.createActor<ManagementService>(managementIdlFactory, {
    agent,
    canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
    effectiveCanisterId: canisterId,
  });
  const { canister_log_records } = await actor.fetch_canister_logs({ canister_id: canisterId });
  const decoder = new TextDecoder();
  return canister_log_records
    .map((record) => ({ idx: record.idx, timestamp: record.timestamp_nanos, text: decoder.decode(record.content) }))
    .sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : 0));
}
