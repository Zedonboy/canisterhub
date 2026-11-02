import { Actor, AnonymousIdentity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { inventoryCanisterId } from "./canisterId";
import { idlFactory, type InventoryService } from "./candid/inventory";
import { resolveCustomerIdentity } from "./customerAuth";

async function make(identity: Parameters<typeof getAgent>[0]): Promise<InventoryService> {
  const agent = await getAgent(identity);
  return Actor.createActor<InventoryService>(idlFactory, { agent, canisterId: Principal.fromText(inventoryCanisterId()) });
}

/** Browsing the catalogue needs no account. */
export const getPublicActor = () => make(new AnonymousIdentity());

/** Orders belong to the signed-in customer's own Internet Identity. */
export async function getCustomerActor(): Promise<InventoryService> {
  return make(await resolveCustomerIdentity());
}
