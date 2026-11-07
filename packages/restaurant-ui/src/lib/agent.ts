// Real IC-agent plumbing for calling `restaurant` directly from the browser -
// ported from `frontend/src/lib/agent.ts`, trimmed to this app's one fixed
// canister/network (see `canisterId.ts`): no per-call `network` parameter,
// no multi-canister-dashboard root-key cookie to read from.

import { HttpAgent } from "@icp-sdk/core/agent";
import { resolveIdentity } from "./auth";
import { network } from "./canisterId";
import { delegationEpoch } from "./parentDelegation";

function icHost(): string {
  if (network() === "ic") return "https://icp0.io";
  const host = window.location.hostname;
  // When served by the local canister gateway, requests stay on that gateway
  // origin. The standalone Vite dev server uses the replica's default port.
  if (window.location.port === "8000" || host.endsWith(".localhost")) return window.location.origin;
  return "http://localhost:8000";
}

/** One agent per signed-in identity, reused rather than rebuilt on every
 * call (`HttpAgent.create` does real async setup) - see
 * `frontend/src/lib/agent.ts`'s own doc comment for why this is keyed by
 * identity, not just called once: signing in or out must get a fresh
 * agent, never a stale anonymous (or stale previously-signed-in) one. */
const agentCache = new Map<string, Promise<HttpAgent>>();

let cachedEpoch = delegationEpoch();

export async function getAgent(): Promise<HttpAgent> {
  const identity = await resolveIdentity();
  // a renewed delegation acts as the same principal but is a different
  // identity - agents built from the old one would send expired signatures
  if (cachedEpoch !== delegationEpoch()) {
    agentCache.clear();
    cachedEpoch = delegationEpoch();
  }
  const cacheKey = identity.getPrincipal().toText();
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const built = (async () => {
    const isLocal = network() !== "ic";
    const agent = await HttpAgent.create({ host: icHost(), identity });
    if (isLocal) {
      await agent.fetchRootKey();
    }
    return agent;
  })();
  built.catch(() => agentCache.delete(cacheKey));

  agentCache.set(cacheKey, built);
  return built;
}

let anonymousAgent: Promise<HttpAgent> | null = null;

/** An agent with no identity, for public queries that must run before (or
 * regardless of) any sign-in/delegation - e.g. finding the storage canister,
 * which the delegation request itself depends on. */
export function getAnonymousAgent(): Promise<HttpAgent> {
  anonymousAgent ??= (async () => {
    const agent = await HttpAgent.create({ host: icHost() });
    if (network() !== "ic") await agent.fetchRootKey();
    return agent;
  })();
  anonymousAgent.catch(() => {
    anonymousAgent = null;
  });
  return anonymousAgent;
}
