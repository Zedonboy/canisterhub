// Typed actor construction for every canister this dashboard calls
// directly - the frontend half of "data involving a canister should be
// pulled directly from the canister to the dashboard" (the user's own
// framing). Each function builds a fresh `@icp-sdk/core` actor bound to
// `getAgent(network)` (see `lib/agent.ts`) - actors themselves are cheap to
// construct (no network round trip), unlike the agent they wrap, which is
// why only the agent is cached.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { runtimeNetwork, runtimeValue } from "./canisterEnv";
import { createActor as createBackendBindingActor, type backendInterface as BackendService } from "../bindings/backend";
import { idlFactory as icSqlIdlFactory, type IcSqlService } from "./candid/icSql";
import { idlFactory as authIdlFactory, type AuthService } from "./candid/auth";
import { idlFactory as connectorConfigIdlFactory, type ConnectorService } from "./candid/connector";
import { idlFactory as agentCanisterIdlFactory, type AgentService } from "./candid/agentCanister";
import { connectorIdlFactory, agentIdlFactory, llmContextIdlFactory, type ConnectorStats, type AgentStats } from "./candid/buildingBlock";
import { idlFactory as moduleConfigIdlFactory, type ModuleConfigService } from "./candid/moduleConfig";
import { idlFactory as canisterMetadataIdlFactory, type CanisterMetadataService } from "./candid/canisterMetadata";

export type MarketplaceService = BackendService;
export type { BackendService, IcSqlService, AuthService, ConnectorService, AgentService, ConnectorStats, AgentStats, ModuleConfigService, CanisterMetadataService };

/** `backend`'s own canister id - required, no sane default (unlike the IC
 * host, this differs per deployment, not per network) - see
 * `orchestrator::config::Config::marketplace_canister_id`'s own doc
 * comment for why that field is confusingly named after the marketplace:
 * this is that same canister. */
export function backendCanisterId(): Principal {
  const id = runtimeValue("PUBLIC_CANISTER_ID:backend");
  if (!id) {
    throw new Error("PUBLIC_CANISTER_ID:backend is missing from the runtime canister environment. Deploy all canisters together, or run the configured Vite dev server.");
  }
  return Principal.fromText(id);
}

/** `backend` always lives on `Config::auth_network` (wherever it's
 * actually deployed - see `ic::backend`'s own doc comment on the
 * orchestrator side), which need not match any individual project's own
 * `network` - so this takes no `network` parameter and always resolves via
 * the runtime canister environment. */
export async function getBackendActor(): Promise<BackendService> {
  const network = runtimeNetwork();
  const agent = await getAgent(network);
  return createBackendBindingActor(backendCanisterId().toText(), { agent });
}

/** Same physical canister and generated binding as `getBackendActor`; this
 * alias keeps marketplace/vetKD call sites explicit about which part of the
 * backend interface they use. */
export async function getMarketplaceActor(): Promise<MarketplaceService> {
  const network = runtimeNetwork();
  const agent = await getAgent(network);
  return createBackendBindingActor(backendCanisterId().toText(), { agent });
}

/** An individual project's own deployed canisters (unlike `backend`) live
 * on that project's own `network` - always pass the `Project.network`
 * value from `backend::get_project`/`list_my_projects`, not
 * the dashboard's runtime network. */
export async function getIcSqlActor(canisterId: Principal | string, network: string): Promise<IcSqlService> {
  const agent = await getAgent(network);
  return Actor.createActor<IcSqlService>(icSqlIdlFactory, { agent, canisterId });
}

/** `list_profiles`/`get_profile`/`get_config` are controller-only on the
 * real canister - see `candid/auth.ts`'s own doc comment on why that's
 * still real access for the actual signed-in user, not a wall. */
export async function getAuthActor(canisterId: Principal | string, network: string): Promise<AuthService> {
  const agent = await getAgent(network);
  return Actor.createActor<AuthService>(authIdlFactory, { agent, canisterId });
}

export async function getConnectorStats(canisterId: Principal | string, network: string): Promise<ConnectorStats> {
  const agent = await getAgent(network);
  const actor = Actor.createActor<{ get_stats: () => Promise<ConnectorStats> }>(connectorIdlFactory, { agent, canisterId });
  return actor.get_stats();
}

/** `get_config` is controller-only on the real canister - see
 * `candid/connector.ts`'s own doc comment on why that's still real access
 * for the actual signed-in user, and on why the decoded shape deliberately
 * excludes every credential field. */
export async function getConnectorActor(canisterId: Principal | string, network: string): Promise<ConnectorService> {
  const agent = await getAgent(network);
  return Actor.createActor<ConnectorService>(connectorConfigIdlFactory, { agent, canisterId });
}

export async function getAgentStats(canisterId: Principal | string, network: string): Promise<AgentStats> {
  const agent = await getAgent(network);
  const actor = Actor.createActor<{ get_stats: () => Promise<AgentStats> }>(agentIdlFactory, { agent, canisterId });
  return actor.get_stats();
}

/** `get_config`/`update_config`/`receive_message`/`get_conversation` - see
 * `candid/agentCanister.ts`'s own doc comment on why these all work for the
 * real signed-in user (a controller) and on why the decoded config shape
 * deliberately excludes every credential field. Named `AgentCanister*`
 * rather than `Agent*` to keep this distinct from `getAgent` (the generic
 * `@icp-sdk/core` `HttpAgent` factory) above - two unrelated meanings of
 * "agent" that happen to collide in this codebase. */
export async function getAgentCanisterActor(canisterId: Principal | string, network: string): Promise<AgentService> {
  const agent = await getAgent(network);
  return Actor.createActor<AgentService>(agentCanisterIdlFactory, { agent, canisterId });
}

/** `canister-hub-sdk`'s `ic::config` surface (see
 * `candid/moduleConfig.ts`'s own doc comment) - not every canister
 * implements it, so every caller of this actor must expect the individual
 * calls to reject on one that doesn't, not just this factory. */
export async function getModuleConfigActor(canisterId: Principal | string, network: string): Promise<ModuleConfigService> {
  const agent = await getAgent(network);
  return Actor.createActor<ModuleConfigService>(moduleConfigIdlFactory, { agent, canisterId });
}

/** `canister-hub-sdk`'s `ic::metadata` surface (see
 * `candid/canisterMetadata.ts`'s own doc comment) - an independent,
 * decoupled candid interface from `ModuleConfigService` above; not every
 * canister implements it either. */
export async function getCanisterMetadataActor(canisterId: Principal | string, network: string): Promise<CanisterMetadataService> {
  const agent = await getAgent(network);
  return Actor.createActor<CanisterMetadataService>(canisterMetadataIdlFactory, { agent, canisterId });
}

/** Every kind that exposes `llm_context` (`connector`/`agent`/
 * `admin_agent`/`auth`/database) shares this exact shape - see
 * `candid/buildingBlock.ts`'s own doc comment. */
export async function getLlmContext(canisterId: Principal | string, network: string): Promise<string> {
  const agent = await getAgent(network);
  const actor = Actor.createActor<{ llm_context: () => Promise<string> }>(llmContextIdlFactory, { agent, canisterId });
  return actor.llm_context();
}
