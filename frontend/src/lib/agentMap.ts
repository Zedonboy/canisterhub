// Real cross-canister wiring for the "Agent Map" - reads and writes the
// actual `Config` fields that link a project's own connector and agent
// canisters (`connector.agent_canister` <-> `agent.connector_principal`),
// via direct `update_config` calls. Database and storage canisters remain
// visible architecture nodes, but the agent stores its own state and has no
// external database/storage wiring field.

import { Principal } from "@icp-sdk/core/principal";
import { getConnectorActor, getAgentCanisterActor, getIcSqlActor, getLlmContext } from "./actors";
import { listConnectorCanisters } from "./connectors";
import { listAgentCanisters, getAgentConfig } from "./agentCanisters";
import { listDatabaseCanisters } from "./database";
import { listStorageCanisters } from "./assetStorage";
import type { Project } from "./backend";

export type MapNodeKind = "connector" | "agent" | "database" | "storage";

export interface MapNode {
  kind: MapNodeKind;
  name: string;
  id: string;
}

export interface MapEdge {
  kind: "connector-agent";
  from: MapNode;
  to: MapNode;
}

export interface AgentMapData {
  connectors: MapNode[];
  agents: MapNode[];
  databases: MapNode[];
  storages: MapNode[];
  edges: MapEdge[];
  /** Per-agent config read failures (most commonly: not a controller of
   * that specific canister) - the map still renders every node and
   * whatever edges it *could* read; this just means an agent's own real
   * edges might be missing rather than wrong. */
  readErrors: Record<string, string>;
}

function toNode(kind: MapNodeKind, c: { name: string; id: string }): MapNode {
  return { kind, name: c.name, id: c.id };
}

/** Every wireable node on this project, plus every real edge currently
 * configured - read directly off each agent's own `get_config` (the only
 * side that exposes the link at all: `connector`'s own `agent_canister` is
 * also real and controller-only, but the agent side is enough to draw
 * every edge this map cares about, and avoids N+1 controller-gated reads
 * on top of the ones already needed for `Agents.tsx`'s own tab). */
export async function loadAgentMap(project: Project): Promise<AgentMapData> {
  const connectors = listConnectorCanisters(project).map((c) => toNode("connector", c));
  const agents = listAgentCanisters(project).map((c) => toNode("agent", c));
  const databases = listDatabaseCanisters(project)
    .filter((d) => d.kind === "sql")
    .map((d) => toNode("database", d));
  const storages = (await listStorageCanisters(project)).map((c) => toNode("storage", c));

  const edges: MapEdge[] = [];
  const readErrors: Record<string, string> = {};

  await Promise.all(
    agents.map(async (agent) => {
      try {
        const config = await getAgentConfig(agent.id, project.network);
        if (config.connectorPrincipal) {
          const connector = connectors.find((c) => c.id === config.connectorPrincipal);
          if (connector) edges.push({ kind: "connector-agent", from: connector, to: agent });
        }
      } catch (e) {
        readErrors[agent.id] = e instanceof Error ? e.message : String(e);
      }
    })
  );

  return { connectors, agents, databases, storages, edges, readErrors };
}

/** Every other `AgentConfigUpdate` field left as `[]` ("not mentioned") -
 * see `candid/agentCanister.ts`'s own doc comment on the three-state
 * convention. Used by every wire/unwire function below so none of them
 * ever risk touching a field the user didn't ask to change (in particular:
 * never the write-only `llm_api_key`/`admin_webhook_secret`). */
function untouchedAgentFields() {
  return {
    project_id: [] as [] | [[] | [string]],
    protocol_id: [] as [] | [[] | [Principal]],
    admin_webhook_url: [] as [] | [[] | [string]],
    system_prompt: [] as [] | [[] | [string]],
    admin_webhook_secret: [] as [] | [[] | [string]],
    whatsapp_verify_token: [] as [] | [[] | [string]],
    whatsapp_app_secret: [] as [] | [[] | [string]],
    whatsapp_access_token: [] as [] | [[] | [string]],
    whatsapp_phone_number_id: [] as [] | [[] | [string]],
    llm_provider: [] as [] | [[] | [string]],
    max_tool_iterations: [] as [] | [[] | [number]],
    llm_api_key: [] as [] | [[] | [string]],
    llm_model: [] as [] | [[] | [string]],
    connector_principal: [] as [] | [[] | [Principal]],
  };
}

/** Real, two-sided wiring: sets `agent.Config.connector_principal` *and*
 * `connector.Config.agent_canister` together. A connector pointed at an
 * agent that doesn't also accept messages back from it would be a broken,
 * one-sided wire - `receive_message`'s own gate checks the agent side,
 * `Config.agent_canister`'s own doc comment describes the connector side
 * ("a canister to forward every successfully-stored inbound message to").
 * Only ever declares the one field each side is changing - see
 * `ConnectorAgentWireUpdate`'s and `untouchedAgentFields`'s own doc
 * comments on why that's real, not approximate. */
export async function wireConnectorToAgent(connector: MapNode, agent: MapNode, network: string): Promise<void> {
  const connectorActor = await getConnectorActor(connector.id, network);
  const connectorResult = await connectorActor.update_config({ agent_canister: [[Principal.fromText(agent.id)]] });
  if ("Err" in connectorResult) throw new Error(`${connector.name}: ${connectorResult.Err}`);

  const agentActor = await getAgentCanisterActor(agent.id, network);
  const agentResult = await agentActor.update_config({ ...untouchedAgentFields(), connector_principal: [[Principal.fromText(connector.id)]] });
  if ("Err" in agentResult) throw new Error(`${agent.name}: ${agentResult.Err}`);
}

/** Clears both sides of a real `wireConnectorToAgent` link. */
export async function unwireConnectorFromAgent(connector: MapNode, agent: MapNode, network: string): Promise<void> {
  const connectorActor = await getConnectorActor(connector.id, network);
  const connectorResult = await connectorActor.update_config({ agent_canister: [[]] });
  if ("Err" in connectorResult) throw new Error(`${connector.name}: ${connectorResult.Err}`);

  const agentActor = await getAgentCanisterActor(agent.id, network);
  const agentResult = await agentActor.update_config({ ...untouchedAgentFields(), connector_principal: [[]] });
  if ("Err" in agentResult) throw new Error(`${agent.name}: ${agentResult.Err}`);
}

/** Real `llm_context()` text for any node that has one - connector, agent,
 * and `ic-sql` all expose it (open to any caller on the real canister).
 * `storage` canisters have no such method at all (the certified-assets
 * interface doesn't define one) - callers should never invoke this for a
 * `storage` node; see `AgentMapPage`'s own doc comment. */
export async function getNodeLlmContext(node: MapNode, network: string): Promise<string> {
  if (node.kind === "database") {
    const actor = await getIcSqlActor(node.id, network);
    return actor.llm_context();
  }
  return getLlmContext(node.id, network);
}
