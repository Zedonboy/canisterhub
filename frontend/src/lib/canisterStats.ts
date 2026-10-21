// Real, direct-to-canister stats for one project's canisters - the
// frontend replacement for `orchestrator::routes::jobs::get_canister_stats`
// (removed - see the architecture plan this implements). Every call here
// goes straight to the canister in question (or, for module_hash/
// controllers, to the IC's own public read_state certificate path) - no
// orchestrator HTTP call anywhere in this file.

import { CanisterStatus } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { Actor } from "@icp-sdk/core/agent";
import { getAgent } from "./agent";
import { getConnectorStats, getAgentStats, getModuleConfigActor } from "./actors";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";
import type { CanisterKind } from "./backend";
import { localIcHost, mainnetIcHost } from "./canisterEnv";
import { getCanisterMetadata } from "./canisterMetadata";
import type { CanisterType } from "./candid/canisterMetadata";
import { resolveModuleUrl } from "./moduleConfig";

export interface BusinessStats {
  messages_processed?: number;
  messages_in?: number;
  messages_out?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  tokens_consumed?: number;
}

export interface CanisterStats {
  id: string;
  kind: CanisterKind;
  /** `null` unless this dashboard's identity happens to control the
   * canister (true on this project's own local dev network - a real
   * quirk, not something to expect on a mainnet job) - see
   * `candid/management.ts`'s own doc comment. */
  status: "running" | "stopping" | "stopped" | null;
  memory_size: number | null;
  cycles: number | null;
  /** The real IC's own idle burn-rate figure for this canister alone - see
   * `candid/management.ts`'s own doc comment. `null` under the same
   * controller-only condition as `status`/`memory_size`/`cycles` above. */
  idle_cycles_burned_per_day: number | null;
  /** Seconds of projected runway (at the canister's current cycles balance
   * and burn rate) below which the IC freezes it (rejects update calls) -
   * the one other `canister_status` field worth surfacing alongside burn
   * rate, since it's what burn rate is actually counting down toward. Same
   * controller-only availability. */
  freezing_threshold: number | null;
  /** The module's own optional `canister_metadata().canister_type`, not the
   * broader project-side `kind`. `null` means the module declared no type
   * or does not implement the metadata API. */
  canister_type: CanisterType | null;
  /** `canister_metadata().version` - the calling crate's own `Cargo.toml`
   * version unless it declared a different one explicitly (see
   * `sdk/src/ic/metadata.rs`'s own doc comment). `null` only when the
   * module doesn't implement `canister_metadata!` at all - every module
   * that does always has *some* version string, never an empty one. */
  version: string | null;
  /** Unlike the fields above, always available regardless of controller
   * status - a plain `read_state` certificate path, not a `canister_status`
   * call. */
  module_hash: string | null;
  controllers: string[];
  url: string | null;
  business?: BusinessStats;
  /** Whether this canister implements `canister-hub-sdk`'s `ic::config`
   * surface at all (a `#[dynamic_config]` Marketplace Module) - decides
   * whether the card shows an "Edit Settings" action. Independent of
   * `admin_panel_url`/`home_page_url`, which a module may implement the
   * config surface without declaring either of. */
  has_config: boolean;
  admin_panel_url: string | null;
  home_page_url: string | null;
  error?: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function icHostFor(network: string): string {
  if (network === "ic") return mainnetIcHost();
  return localIcHost();
}

/** A static canister's own homepage URL - the real replacement for
 * `get_canister_stats`'s own `url` computation, minus the local network's
 * exact gateway port lookup (`icp network status`) that only the
 * orchestrator's own local disk access could do: the query-param form
 * below works on any icp-cli local gateway without needing it. */
function staticUrl(id: string, network: string): string {
  if (network === "ic") return `https://${id}.icp0.io/`;
  return `${icHostFor(network)}/?canisterId=${id}`;
}

/** Best-effort: `module_hash`/`controllers` via a plain `read_state`
 * certificate-path query - no controller permission needed, works for any
 * canister on any network (unlike `readControllerOnlyInfo` below, this
 * never hits the local gateway's `aaaaa-aa`-routing rejection, since it's a
 * certificate read against the target canister's own subnet, not a call to
 * the management canister). Returns `null`/`[]` on failure (e.g. the
 * canister/network is unreachable) rather than throwing, matching this
 * whole module's "one canister's failure doesn't break the rest"
 * convention. Exported for `runtime.ts::attachRuntimeCanister`, which reuses
 * this exact mechanism to confirm a caller actually controls a canister ID
 * they're attaching, without needing `canister_status` to succeed. */
export async function readPublicInfo(canisterId: Principal, network: string): Promise<{ module_hash: string | null; controllers: string[] }> {
  try {
    const agent = await getAgent(network);
    const status = await CanisterStatus.request({ agent, canisterId, paths: ["module_hash", "controllers"] });
    const moduleHash = status.get("module_hash");
    const controllersRaw = status.get("controllers");
    return {
      module_hash: moduleHash instanceof Uint8Array ? hex(moduleHash) : null,
      controllers: Array.isArray(controllersRaw) ? controllersRaw.map((p) => (p instanceof Principal ? p.toText() : String(p))) : [],
    };
  } catch {
    return { module_hash: null, controllers: [] };
  }
}

/** Best-effort: the full `canister_status` (memory/cycles/status) - only
 * succeeds when this dashboard's identity happens to be a controller. See
 * `candid/management.ts`'s own doc comment. `null` fields on failure, not
 * a thrown error - this is always an addition to `readPublicInfo`, never
 * something the rest of a canister's stats depend on.
 *
 * The target is also supplied as `effectiveCanisterId`; management calls
 * otherwise route as though `aaaaa-aa` were a normal canister and local or
 * multi-subnet gateways can answer with `canister_not_found`. */
async function readControllerOnlyInfo(canisterId: Principal, network: string): Promise<{
  status: CanisterStats["status"];
  memory_size: number | null;
  cycles: number | null;
  idle_cycles_burned_per_day: number | null;
  freezing_threshold: number | null;
}> {
  try {
    const agent = await getAgent(network);
    const actor = Actor.createActor<ManagementService>(managementIdlFactory, {
      agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId: canisterId,
    });
    const result = await actor.canister_status({ canister_id: canisterId });
    const status = "running" in result.status ? "running" : "stopping" in result.status ? "stopping" : "stopped";
    return {
      status,
      memory_size: Number(result.memory_size),
      cycles: Number(result.cycles),
      idle_cycles_burned_per_day: Number(result.idle_cycles_burned_per_day),
      freezing_threshold: Number(result.settings.freezing_threshold),
    };
  } catch {
    return { status: null, memory_size: null, cycles: null, idle_cycles_burned_per_day: null, freezing_threshold: null };
  }
}

async function businessStatsFor(canisterId: Principal, kind: CanisterKind, network: string): Promise<BusinessStats | undefined> {
  try {
    if (kind === "connector") {
      const stats = await getConnectorStats(canisterId, network);
      return { messages_processed: Number(stats.messages_processed) };
    }
    if (kind === "agent") {
      const stats = await getAgentStats(canisterId, network);
      const prompt = Number(stats.prompt_tokens);
      const completion = Number(stats.completion_tokens);
      return {
        messages_in: Number(stats.messages_in),
        messages_out: Number(stats.messages_out),
        prompt_tokens: prompt,
        completion_tokens: completion,
        tokens_consumed: prompt + completion,
      };
    }
    return undefined;
  } catch {
    // No `get_stats` on this kind, or the call failed - additive, never
    // something the rest of this canister's stats depend on (matches
    // `orchestrator::routes::jobs::business_stats_for`'s own convention).
    return undefined;
  }
}

/** Best-effort: `get_admin_panel_url`/`get_home_page_url`, and whether the
 * canister implements `canister-hub-sdk`'s `ic::config` surface at all
 * (both calls only ever succeed together - the SDK's macro always
 * generates all five config endpoints as one unit, never a subset). A
 * canister that wasn't built with that SDK (or is simply unreachable)
 * rejects both, which reads as "no config here", not an error - additive,
 * same spirit as `businessStatsFor`. */
async function moduleLinksFor(canisterId: Principal, network: string): Promise<{ has_config: boolean; admin_panel_url: string | null; home_page_url: string | null }> {
  try {
    const actor = await getModuleConfigActor(canisterId, network);
    const [adminPanelUrl, homePageUrl] = await Promise.all([actor.get_admin_panel_url(), actor.get_home_page_url()]);
    return {
      has_config: true,
      admin_panel_url: resolveModuleUrl(canisterId.toText(), network, adminPanelUrl.length === 0 ? null : adminPanelUrl[0]),
      home_page_url: resolveModuleUrl(canisterId.toText(), network, homePageUrl.length === 0 ? null : homePageUrl[0]),
    };
  } catch {
    return { has_config: false, admin_panel_url: null, home_page_url: null };
  }
}

/** Real, live stats for one canister, fetched directly (no orchestrator
 * HTTP call) - best-effort per field, same spirit as the old
 * `get_canister_stats` endpoint this replaces: a canister that's
 * unreachable right now reports its own `error` instead of failing every
 * other canister's card. */
export async function getCanisterStatsDirect(name: string, id: string, kind: CanisterKind, network: string): Promise<CanisterStats> {
  try {
    const principal = Principal.fromText(id);
    const [publicInfo, controllerOnlyInfo, business, moduleLinks, metadata] = await Promise.all([
      readPublicInfo(principal, network),
      readControllerOnlyInfo(principal, network),
      businessStatsFor(principal, kind, network),
      moduleLinksFor(principal, network),
      getCanisterMetadata(id, network),
    ]);
    return {
      id,
      kind,
      status: controllerOnlyInfo.status,
      memory_size: controllerOnlyInfo.memory_size,
      cycles: controllerOnlyInfo.cycles,
      idle_cycles_burned_per_day: controllerOnlyInfo.idle_cycles_burned_per_day,
      freezing_threshold: controllerOnlyInfo.freezing_threshold,
      canister_type: metadata?.canister_type[0] ?? null,
      version: metadata?.version ?? null,
      module_hash: publicInfo.module_hash,
      controllers: publicInfo.controllers,
      url: kind === "static" ? staticUrl(id, network) : null,
      business,
      ...moduleLinks,
    };
  } catch (e) {
    return {
      id, kind, status: null, memory_size: null, cycles: null, idle_cycles_burned_per_day: null, freezing_threshold: null,
      canister_type: null, version: null, module_hash: null, controllers: [], url: null,
      has_config: false, admin_panel_url: null, home_page_url: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Every canister in `canisters`, fetched in parallel - the direct
 * replacement for `GET /jobs/:id/canisters`. */
export async function getAllCanisterStats(canisters: Record<string, { id: string; kind: CanisterKind }>, network: string): Promise<Record<string, CanisterStats>> {
  const entries = await Promise.all(
    Object.entries(canisters).map(async ([name, info]) => [name, await getCanisterStatsDirect(name, info.id, info.kind, network)] as const)
  );
  return Object.fromEntries(entries);
}

/** The real, project-wide "Burn Rate" - every canister's own
 * `idle_cycles_burned_per_day` (see `candid/management.ts`'s own doc
 * comment), summed. Callers fetch `getAllCanisterStats` exactly once and
 * derive both this total and any per-service breakdown from that same
 * result, rather than re-querying `canister_status` for the same canisters
 * twice. Skips (doesn't zero-fill) any canister this identity doesn't
 * control, matching this whole module's best-effort convention - a project
 * with zero controlled canisters reports `0`, not a misleadingly-complete
 * total. */
export function totalBurnRatePerDay(stats: Record<string, CanisterStats>): number {
  return Object.values(stats).reduce((sum, s) => sum + (s.idle_cycles_burned_per_day ?? 0), 0);
}
