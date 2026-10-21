// Real connector data for the Agent page's "Connectors" tab - direct
// canister calls, no orchestrator HTTP call anywhere in this file. A
// `connector` canister is the gateway half of the pair described in
// `orchestrator::llm::mod`'s own PREAMBLE: "receives messages from the
// outside world (WhatsApp/Telegram/email) and forwards them to an agent
// canister" - `Config::agent_canister` is the real, queryable wiring that
// makes that link visible from here, not just documentation.

import { getConnectorActor } from "./actors";
import type { Project, CanisterInfo } from "./backend";

export interface ConnectorCanister {
  name: string;
  id: string;
}

export interface ConnectorSummary {
  name: string;
  id: string;
  messagesProcessed: bigint;
  /** The agent canister this connector forwards inbound messages to
   * (`Config::agent_canister`), or `null` if unset. Only ever populated
   * when `configError` is `null` - `get_config` is controller-only (see
   * `candid/connector.ts`), so a non-controller caller genuinely can't see
   * this even though `messagesProcessed` above still works. */
  agentCanister: string | null;
  authorizedSender: string | null;
  /** Set when `get_config` failed (most commonly: this caller isn't a
   * controller of this specific canister) - `messagesProcessed` above is
   * still real regardless, since `get_stats` has no such gate. Surfaced as
   * a caution icon in the UI, not inline error text - same convention
   * `Wallet.tsx`'s own token rows use for a failed balance read. */
  configError: string | null;
}

/** Every real connector canister on this project - a pure client-side
 * filter of `Project.canisters` (already fetched from `backend`), no
 * canister call needed. Mirrors `authProfiles.ts::listAuthCanisters`'s own
 * shape exactly. */
export function listConnectorCanisters(project: Project): ConnectorCanister[] {
  return Object.entries(project.canisters)
    .filter(([, info]: [string, CanisterInfo]) => info.kind === "connector")
    .map(([name, info]) => ({ name, id: info.id }));
}

export async function getConnectorSummary(name: string, canisterId: string, network: string): Promise<ConnectorSummary> {
  const actor = await getConnectorActor(canisterId, network);
  const stats = await actor.get_stats();
  try {
    const result = await actor.get_config();
    if ("Err" in result) {
      return { name, id: canisterId, messagesProcessed: stats.messages_processed, agentCanister: null, authorizedSender: null, configError: result.Err };
    }
    const config = result.Ok;
    return {
      name,
      id: canisterId,
      messagesProcessed: stats.messages_processed,
      agentCanister: config.agent_canister[0]?.toText() ?? null,
      authorizedSender: config.authorized_sender[0]?.toText() ?? null,
      configError: null,
    };
  } catch (e) {
    return {
      name,
      id: canisterId,
      messagesProcessed: stats.messages_processed,
      agentCanister: null,
      authorizedSender: null,
      configError: e instanceof Error ? e.message : String(e),
    };
  }
}
