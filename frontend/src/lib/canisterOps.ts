// Real, direct-to-canister lifecycle operations - the frontend's own
// counterpart to `lib/canisterStats.ts`'s read-only calls. Every function
// here calls the IC management canister (`aaaaa-aa`) directly with this
// dashboard's own signed-in identity - no orchestrator HTTP call anywhere
// in this file. Succeeds only when that identity is a controller of the
// target, which is genuinely true for the real signed-in user on every
// canister the orchestrator deploys for them - see
// `candid/management.ts`'s own doc comment and the `per-user-canister-ownership`
// project notes. Management calls use the target canister as their effective
// canister id so the gateway can route them to the target's subnet.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";

async function managementActor(network: string, targetCanisterId: Principal): Promise<ManagementService> {
  const agent = await getAgent(network);
  return Actor.createActor<ManagementService>(managementIdlFactory, {
    agent,
    canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
    effectiveCanisterId: targetCanisterId,
  });
}

/** Stops a canister - it keeps running any call already in flight and only
 * resolves once it's fully drained to `Stopped` (real IC semantics, not
 * something this function polls for). */
export async function stopCanister(id: string, network: string): Promise<void> {
  const canisterId = Principal.fromText(id);
  const actor = await managementActor(network, canisterId);
  await actor.stop_canister({ canister_id: canisterId });
}

export async function startCanister(id: string, network: string): Promise<void> {
  const canisterId = Principal.fromText(id);
  const actor = await managementActor(network, canisterId);
  await actor.start_canister({ canister_id: canisterId });
}

/** Irreversibly deletes a canister - stops it first (the IC rejects
 * `delete_canister` outright on anything still `Running`/`Stopping`), so
 * one call here is the complete, real "delete this canister" operation.
 * Callers still need to drop it from `backend::Project.canisters`
 * themselves once this resolves - see `lib/backend.ts::removeProjectCanister` -
 * this function only ever touches the IC's own canister, never `backend`'s
 * record of it. */
export async function deleteCanister(id: string, network: string): Promise<void> {
  const canister_id = Principal.fromText(id);
  const actor = await managementActor(network, canister_id);
  await actor.stop_canister({ canister_id });
  await actor.delete_canister({ canister_id });
}
