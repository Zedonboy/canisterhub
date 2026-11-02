// Real data + actions for the Agent page's "Agents" tab - direct canister
// calls to a project's fused messaging + `agent` canister(s), no orchestrator HTTP
// call anywhere in this file. Backs both the Test dialog (real
// `receive_message` + `get_conversation`) and the Config dialog (real
// `get_config`/`update_config`) - see `candid/agentCanister.ts`'s own doc
// comment on access (controller-only, which the real signed-in user
// genuinely is here).

import { Principal } from "@icp-sdk/core/principal";
import { getAgentCanisterActor } from "./actors";
import type { Project, CanisterInfo } from "./backend";
import type { Channel as RawChannel, StoredChatMessage } from "./candid/agentCanister";

export interface AgentCanister {
  name: string;
  id: string;
}

export function listAgentCanisters(project: Project): AgentCanister[] {
  return Object.entries(project.canisters)
    .filter(([, info]: [string, CanisterInfo]) => info.kind === "agent")
    .map(([name, info]) => ({ name, id: info.id }));
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

function adaptTurn(raw: StoredChatMessage): ChatTurn {
  return {
    role: "User" in raw.role ? "user" : "assistant",
    content: raw.content,
    at: new Date(Number(raw.at / 1_000_000n)).toISOString(),
  };
}

const TEST_CHANNEL: RawChannel = { Email: null };

/** One fixed conversation key the Test dialog always uses, per agent
 * canister - real conversations from real connectors use whatever
 * session_id that channel provides (a phone number, chat id, email
 * address); this dashboard isn't any of those, so it picks its own stable
 * identity rather than colliding with a real customer's. Using the same
 * session_id every time also means re-opening Test on the same canister
 * continues the same test conversation instead of starting a fresh one
 * each time - closer to what testing an assistant is actually for. */
const TEST_SESSION_ID = "__canister_hub_dashboard_test__";

/** The real, already-persisted transcript for this dashboard's own test
 * conversation - `get_conversation` is a query, safe to call before
 * sending anything (an agent with no test history yet just comes back
 * empty). */
export async function getTestConversation(canisterId: string, network: string): Promise<ChatTurn[]> {
  const actor = await getAgentCanisterActor(canisterId, network);
  const result = await actor.get_conversation(TEST_CHANNEL, TEST_SESSION_ID);
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return result.Ok.history.map(adaptTurn);
}

/** Runs one real message through the fused canister's LLM/tool loop. The
 * dashboard is a controller, so this manual ingress path needs no separate
 * connector principal. A channel-send failure may happen after persistence,
 * so the transcript read remains authoritative. */
export async function sendTestMessage(canisterId: string, network: string, text: string): Promise<ChatTurn[]> {
  const actor = await getAgentCanisterActor(canisterId, network);
  const result = await actor.receive_message({ session_id: TEST_SESSION_ID, text, channel: TEST_CHANNEL });
  // Either Ok, or a non-blocking post-persistence relay failure (see this
  // function's own doc comment) - either way, re-read the real transcript.
  return getTestConversation(canisterId, network);
}

export interface AgentConfigSummary {
  adminWebhookUrl: string | null;
  whatsappPhoneNumberId: string | null;
  systemPrompt: string | null;
  /** Managed platform or direct/BYOK provider identifier. */
  llmProvider: string | null;
  llmModel: string | null;
  maxToolIterations: number | null;
  /** Legacy map compatibility; fused agents always return null. */
  connectorPrincipal: string | null;
  /** Not readable from `get_config` at all (write-only credential - see
   * `candid/agentCanister.ts`) - `true` only tells you a value exists on
   * `update_config`'s own three-state semantics, never what it is. */
}

function optToNullable<T>(opt: [] | [T]): T | null {
  return opt.length === 0 ? null : opt[0];
}

export async function getAgentConfig(canisterId: string, network: string): Promise<AgentConfigSummary> {
  const actor = await getAgentCanisterActor(canisterId, network);
  const result = await actor.get_runtime_config();
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  const c = result.Ok;
  return {
    adminWebhookUrl: optToNullable(c.admin_webhook_url),
    whatsappPhoneNumberId: optToNullable(c.whatsapp_phone_number_id),
    systemPrompt: optToNullable(c.system_prompt),
    llmProvider: optToNullable(c.llm_provider),
    llmModel: optToNullable(c.llm_model),
    maxToolIterations: optToNullable(c.max_tool_iterations),
    connectorPrincipal: optToNullable(c.connector_principal)?.toText() ?? null,
  };
}

/** What the Config dialog submits. Every field here is always explicitly
 * set-or-cleared (blank = clear) *except* credential fields
 * - both write-only (see `AgentConfigSummary`'s own doc comment), so
 * `undefined` there means "leave whatever's already configured alone"
 * (the outer `[]` "not mentioned" state), distinct from an empty string
 * meaning "clear it". */
export interface AgentConfigPatch {
  adminWebhookUrl: string;
  whatsappPhoneNumberId: string;
  systemPrompt: string;
  llmProvider: string;
  llmModel: string;
  maxToolIterations: string;
  llmApiKey?: string | null;
  adminWebhookSecret?: string | null;
  whatsappVerifyToken?: string | null;
  whatsappAppSecret?: string | null;
  whatsappAccessToken?: string | null;
}

function setOrClear(value: string): [] | [[] | [string]] {
  return value.trim() === "" ? [[]] : [[value.trim()]];
}

function setOrClearNat8(value: string): [] | [[] | [number]] {
  const trimmed = value.trim();
  if (trimmed === "") return [[]];
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error("Max tool iterations must be a whole number between 0 and 255.");
  }
  return [[n]];
}

/** `undefined`/`null` => "not mentioned" (leave alone); any string
 * (including `""`) => explicitly set-or-clear, same as every other
 * field. Only used for the two write-only credential fields, where a
 * blank *initial* value must not be mistaken for "the user wants to clear
 * this" - see `AgentConfigPatch`'s own doc comment. */
function writeOnlyField(value: string | null | undefined): [] | [[] | [string]] {
  if (value === undefined || value === null) return [];
  return setOrClear(value);
}

export async function updateAgentConfig(canisterId: string, network: string, patch: AgentConfigPatch): Promise<void> {
  const actor = await getAgentCanisterActor(canisterId, network);
  const result = await actor.update_config({
    project_id: [],
    protocol_id: [],
    connector_principal: [],
    admin_webhook_url: setOrClear(patch.adminWebhookUrl),
    system_prompt: setOrClear(patch.systemPrompt),
    admin_webhook_secret: writeOnlyField(patch.adminWebhookSecret),
    whatsapp_verify_token: writeOnlyField(patch.whatsappVerifyToken),
    whatsapp_app_secret: writeOnlyField(patch.whatsappAppSecret),
    whatsapp_access_token: writeOnlyField(patch.whatsappAccessToken),
    whatsapp_phone_number_id: setOrClear(patch.whatsappPhoneNumberId),
    llm_provider: setOrClear(patch.llmProvider),
    max_tool_iterations: setOrClearNat8(patch.maxToolIterations),
    llm_api_key: writeOnlyField(patch.llmApiKey),
    llm_model: setOrClear(patch.llmModel),
  });
  if ("Err" in result) {
    throw new Error(result.Err);
  }
}
