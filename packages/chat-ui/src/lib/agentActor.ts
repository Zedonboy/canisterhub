import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { resolveCustomerIdentity } from "./customerAuth";
import { agentCanisterId } from "./canisterId";
import { idlFactory, type AgentChatService } from "./candid/agentChat";

/** Actor for the SME inbox: the signed-in (or delegated) identity. */
export async function getAgentActor(): Promise<AgentChatService> {
  const agent = await getAgent();
  return Actor.createActor<AgentChatService>(idlFactory, { agent, canisterId: Principal.fromText(agentCanisterId()) });
}

/** Actor for the customer web channel: the customer's own Internet Identity
 * (never the dashboard delegation - see `customerAuth.ts`). */
export async function getCustomerActor(): Promise<AgentChatService> {
  const agent = await getAgent(await resolveCustomerIdentity());
  return Actor.createActor<AgentChatService>(idlFactory, { agent, canisterId: Principal.fromText(agentCanisterId()) });
}
