// Real IC-agent plumbing for calling the embedding payment canister
// directly from the browser - same shape as `table-browser`'s
// `lib/agent.ts`, trimmed to this app's one fixed canister/network (see
// `canisterId.ts`).

import { HttpAgent } from "@icp-sdk/core/agent";
import { resolveIdentity } from "./auth";
import { network } from "./canisterId";

function icHost(): string {
  if (network() === "ic") return "https://icp0.io";
  // Local replica: same-origin as this page when actually served by the
  // payment canister itself; `window.location.origin` is exactly that
  // origin. The Vite dev server proxies `/api` if you need one (see
  // README.md).
  return window.location.origin;
}

/** One agent per signed-in identity, reused rather than rebuilt on every
 * call (`HttpAgent.create` does real async setup) - keyed by identity, not
 * just called once: signing in or out must get a fresh agent, never a
 * stale anonymous (or stale previously-signed-in) one. */
const agentCache = new Map<string, Promise<HttpAgent>>();

export async function getAgent(): Promise<HttpAgent> {
  const identity = await resolveIdentity();
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
