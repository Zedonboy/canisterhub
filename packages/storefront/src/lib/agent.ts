import { HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { network } from "./canisterId";

function icHost(): string {
  return network() === "ic" ? "https://icp0.io" : window.location.origin;
}

// One agent per principal, so signing in/out never reuses a stale agent.
const agentCache = new Map<string, Promise<HttpAgent>>();

async function buildAgent(identity: Identity): Promise<HttpAgent> {
  const agent = await HttpAgent.create({ host: icHost(), identity });
  if (network() !== "ic") await agent.fetchRootKey();
  return agent;
}

export async function getAgent(identity: Identity): Promise<HttpAgent> {
  const id = identity;
  const key = id.getPrincipal().toText();
  const cached = agentCache.get(key);
  if (cached) return cached;
  const built = buildAgent(id);
  built.catch(() => agentCache.delete(key));
  agentCache.set(key, built);
  return built;
}
