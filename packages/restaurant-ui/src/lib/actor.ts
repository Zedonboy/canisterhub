import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent, getAnonymousAgent } from "./agent";
import { restaurantCanisterId } from "./canisterId";
import { idlFactory, type RestaurantService } from "./candid/restaurant";

/** Not cached itself (cheap, no I/O) - `getAgent()` underneath is the real
 * cache, keyed by identity, so a fresh `Actor` wrapper here always points
 * at the current signed-in identity's agent. */
export async function getRestaurantActor(): Promise<RestaurantService> {
  const agent = await getAgent();
  return Actor.createActor<RestaurantService>(idlFactory, { agent, canisterId: Principal.fromText(restaurantCanisterId()) });
}

/** For public queries only (`get_config` is open to anyone; secrets would be masked). */
export async function getAnonymousRestaurantActor(): Promise<RestaurantService> {
  const agent = await getAnonymousAgent();
  return Actor.createActor<RestaurantService>(idlFactory, { agent, canisterId: Principal.fromText(restaurantCanisterId()) });
}
