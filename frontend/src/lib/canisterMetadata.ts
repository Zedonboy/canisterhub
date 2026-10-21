// Thin wrapper around `canister-hub-sdk`'s `ic::metadata` surface (see
// `candid/canisterMetadata.ts`'s own doc comment) - same "no metadata here,
// not an error" best-effort treatment `lib/moduleConfig.ts::getModuleLinks`
// uses for its own optional calls.

import { getCanisterMetadataActor } from "./actors";
import type { CanisterMetadata } from "./candid/canisterMetadata";

export type { CanisterMetadata };

/** Best-effort: `null` if this canister doesn't implement
 * `canister_metadata!` at all (older module, one that never opted in, or
 * any other kind of canister entirely) - lets a deployer read a
 * just-installed wasm's own declared name/description/type right after
 * `install_code`, e.g. to classify it into the right `CanisterKind` (see
 * `lib/runtime.ts::deployWasmRuntime`) without any out-of-band metadata. */
export async function getCanisterMetadata(canisterId: string, network: string): Promise<CanisterMetadata | null> {
  try {
    const actor = await getCanisterMetadataActor(canisterId, network);
    return await actor.canister_metadata();
  } catch {
    return null;
  }
}
