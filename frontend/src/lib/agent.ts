// Real IC-agent plumbing for calling canisters directly from the browser -
// "data involving a canister should be pulled directly from the canister to
// the dashboard" (the user's own framing). Mirrors
// `services/orchestrator/src/ic/agent.rs`'s own local-vs-mainnet + root-key logic
// (`build_agent`/`build_agent_for_network`) - see that file for the
// server-side half of the same pattern. Uses `@icp-sdk/core`, not the older
// `@dfinity/agent`/`@dfinity/candid`/`@dfinity/principal` packages, per the
// user's explicit direction.

import { HttpAgent } from "@icp-sdk/core/agent";
import { resolveIdentity } from "./auth";
import { canisterEnv, localIcHost, mainnetIcHost } from "./canisterEnv";

/** Matches `orchestrator::config::Config::ic_url_local`'s real default,
 * except for the port: this project's real local dev network runs on
 * `icp`-cli's own gateway (port 8000 - confirmed directly against a real
 * running `icp network start`), not dfx's standard 4943, which
 * `orchestrator`'s own `IC_URL_LOCAL` default still names (only because
 * nothing has overridden that particular default - every real local run
 * this session has used *does* set `IC_URL_LOCAL` to the real port). */
function icHostFor(network: string): string {
  if (network === "ic") {
    return mainnetIcHost();
  }
  return localIcHost();
}

/** One agent per (network, identity) pair, reused rather than rebuilt on
 * every call - `HttpAgent.create` does real async setup (see below), not
 * free to repeat per query. Keyed on the real resolved principal too (not
 * just network - see `resolveIdentity`, `lib/auth.ts`): signing in or out
 * changes which identity a call should use, and a stale anonymous (or
 * stale previously-logged-in) agent must never be handed back for the
 * other state - a fresh identity naturally gets a fresh cache entry this
 * way, with the old one simply left unused rather than needing explicit
 * invalidation. */
const agentCache = new Map<string, Promise<HttpAgent>>();

/** Builds (or reuses a cached) `HttpAgent` for `network` ("local" | "ic"),
 * using the real signed-in identity if there is one (anonymous otherwise -
 * see `resolveIdentity`), and fetching the replica's root key when it's
 * not the real mainnet one - required for any non-mainnet replica to
 * verify query/update call certificates at all, exactly like
 * `ic::agent::build_agent`'s own `local` parameter. **Never call
 * `fetchRootKey` for `network === "ic"`** - the real mainnet root key is
 * baked into `@icp-sdk/core` itself; fetching a substitute over an
 * unauthenticated connection would defeat the whole point of certificate
 * verification. */
export async function getAgent(network: string): Promise<HttpAgent> {
  const identity = await resolveIdentity();
  const cacheKey = `${network}:${identity.getPrincipal().toText()}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const built = (async () => {
    const isLocal = network !== "ic";
    const rootKey = isLocal ? canisterEnv()?.IC_ROOT_KEY : undefined;
    const agent = await HttpAgent.create({ host: icHostFor(network), identity, rootKey });
    if (isLocal && !rootKey) {
      await agent.fetchRootKey();
    }
    return agent;
  })();
  // If setup fails (e.g. the local replica isn't running right now), don't
  // poison the cache forever - a later call for the same network/identity
  // should retry rather than replay the same rejection indefinitely.
  built.catch(() => agentCache.delete(cacheKey));

  agentCache.set(cacheKey, built);
  return built;
}
