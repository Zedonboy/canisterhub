import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { icSqlCanisterId } from "./canisterId";
import { idlFactory, type IcSqlService } from "./candid/icSql";

/** Not cached itself (cheap, no I/O) - `getAgent()` underneath is the real
 * cache, keyed by identity, so a fresh `Actor` wrapper here always points
 * at the current signed-in identity's agent. Same convention as
 * `frontend/src/lib/actors.ts`. */
export async function getIcSqlActor(): Promise<IcSqlService> {
  const agent = await getAgent();
  return Actor.createActor<IcSqlService>(idlFactory, { agent, canisterId: Principal.fromText(icSqlCanisterId()) });
}
