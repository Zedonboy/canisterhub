import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent, getAnonymousAgent } from "./agent";
import { inventoryCanisterId } from "./canisterId";
import { idlFactory, type OrderInventoryService } from "./candid/orderInventory";

/** Not cached itself (cheap, no I/O) - `getAgent()` underneath is the real
 * cache, keyed by identity, so a fresh `Actor` wrapper here always points
 * at the current signed-in identity's agent. */
export async function getInventoryActor(): Promise<OrderInventoryService> {
  const agent = await getAgent();
  return Actor.createActor<OrderInventoryService>(idlFactory, { agent, canisterId: Principal.fromText(inventoryCanisterId()) });
}

/** For public queries only (`get_config` is open to anyone; secrets would be masked). */
export async function getAnonymousInventoryActor(): Promise<OrderInventoryService> {
  const agent = await getAnonymousAgent();
  return Actor.createActor<OrderInventoryService>(idlFactory, { agent, canisterId: Principal.fromText(inventoryCanisterId()) });
}
