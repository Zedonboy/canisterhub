// Thin wrapper around `canister-hub-sdk`'s `ic::config` surface (see
// `candid/moduleConfig.ts`'s own doc comment) - converts the wire
// `Array<[string, ConfigValue]>` config map to/from a plain
// `Record<string, ConfigValue>`, the shape `CanisterSettings.tsx`'s form
// actually works with, the same way `backend.ts` adapts `backend`'s own
// wire types.

import { getModuleConfigActor } from "./actors";
import type { CanisterLink, ConfigFieldSchema, ConfigType, ConfigValue, ConfigVectorType, ConfigVectorValue } from "./candid/moduleConfig";
import { localIcHost, mainnetIcHost } from "./canisterEnv";

export type { CanisterLink, ConfigFieldSchema, ConfigType, ConfigValue, ConfigVectorType, ConfigVectorValue };

/** Expands a module-owned route such as `/admin/` against the target
 * canister's gateway origin. Modules deliberately return only their route;
 * the dashboard owns network selection and therefore knows whether that
 * means a local `*.localhost` URL or a mainnet canister subdomain. Absolute
 * URLs remain supported for modules whose admin UI lives elsewhere. */
export function resolveModuleUrl(canisterId: string, network: string, declaredUrl: string | null): string | null {
  if (!declaredUrl) return null;
  if (/^https?:\/\//i.test(declaredUrl)) return declaredUrl;

  const route = declaredUrl.startsWith("/") ? declaredUrl : `/${declaredUrl}`;
  const configuredHost = new URL(network === "ic" ? mainnetIcHost() : localIcHost());

  if (network === "ic") {
    const port = configuredHost.port ? `:${configuredHost.port}` : "";
    return `${configuredHost.protocol}//${canisterId}.${configuredHost.hostname}${port}${route}`;
  }

  // icp-cli's local gateway supports canister subdomains under `.localhost`.
  // Preserve a configured port (normally 8000), even when IC_HOST_LOCAL uses
  // 127.0.0.1 as the replica/agent host.
  if (configuredHost.hostname === "localhost" || configuredHost.hostname === "127.0.0.1" || configuredHost.hostname.endsWith(".localhost")) {
    const port = configuredHost.port ? `:${configuredHost.port}` : "";
    return `${configuredHost.protocol}//${canisterId}.localhost${port}${route}`;
  }

  // A remote/custom development gateway may not provide wildcard DNS.
  // Its query-parameter form routes to the same target canister.
  const url = new URL(route, configuredHost);
  url.searchParams.set("canisterId", canisterId);
  return url.toString();
}

/** In the canister's own declared field order (a `Vec`, not a map) - a
 * settings form should render fields in the order the module author wrote
 * them, not alphabetically. */
export async function getModuleConfigSchema(canisterId: string, network: string): Promise<ConfigFieldSchema[]> {
  const actor = await getModuleConfigActor(canisterId, network);
  return actor.get_config_schema();
}

export async function getModuleConfig(canisterId: string, network: string): Promise<Record<string, ConfigValue>> {
  const actor = await getModuleConfigActor(canisterId, network);
  const entries = await actor.get_config();
  return Object.fromEntries(entries);
}

/** Throws with the canister's own rejection message on validation failure
 * (unknown key, wrong type, a still-missing required field) - see
 * `ic::config::set`'s own doc comment for the exact rules. A partial
 * update: only pass the keys that actually changed. */
export async function setModuleConfig(canisterId: string, network: string, newSettings: Record<string, ConfigValue>): Promise<void> {
  const actor = await getModuleConfigActor(canisterId, network);
  const result = await actor.set_config(Object.entries(newSettings));
  if ("Err" in result) throw new Error(result.Err);
}

/** Returns every webpage declared by the module, preserving declaration
 * order and resolving canister-relative routes for the active network. */
export async function getModuleLinks(canisterId: string, network: string): Promise<CanisterLink[]> {
  const actor = await getModuleConfigActor(canisterId, network);
  const links = await actor.get_links();
  return links.map((link) => ({
    ...link,
    url: resolveModuleUrl(canisterId, network, link.url) ?? link.url,
  }));
}

/** Whether this canister implements `canister-hub-sdk`'s `ic::config`
 * surface at all (a `#[dynamic_config]` Marketplace Module) - same
 * `has_config` check `canisterStats.ts::moduleLinksFor` does for the
 * canister cards, exposed here too so a caller that hasn't already fetched
 * full `CanisterStats` (e.g. right after a fresh deploy) doesn't have to.
 * A module with no config fields at all still answers `get_config_schema`
 * (with `[]`), so this is `true` regardless of field count - "has config"
 * means "implements the surface", not "has something to configure". */
export async function hasModuleConfig(canisterId: string, network: string): Promise<boolean> {
  try {
    await getModuleConfigSchema(canisterId, network);
    return true;
  } catch {
    return false;
  }
}
