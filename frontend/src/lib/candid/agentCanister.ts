// Hand-written mirror of the real `agent` building block's config/test/
// conversation surface (see `packages/agent/agent.did`) - `get_config`/
// `update_config` are controller-only on the real canister
// (`packages/agent/src/lib.rs::require_controller`); `receive_message` is
// gated on `Config::connector_principal`, but a controller bypasses that
// gate too (`require_authorized`'s own `is_controller` short-circuit) - see
// `packages/agent/src/lib.rs::require_authorized`. The real signed-in user
// genuinely is a controller of every agent canister this dashboard deployed
// for them (same `per-user-canister-ownership` reasoning `candid/auth.ts`'s
// own doc comment describes), so both calls work for real from here, not
// just in principle.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export type Channel = { Email: null } | { WhatsApp: null } | { Telegram: null };
export type Role = { User: null } | { Assistant: null };

export interface StoredChatMessage {
  at: bigint;
  content: string;
  role: Role;
}

export interface ConversationState {
  history: StoredChatMessage[];
}

/** Deliberately omits `llm_api_key` and `admin_webhook_secret` from what
 * this frontend ever *reads* back off `Config` - both are real credentials
 * on the canister side. They're still real, settable fields on
 * `AgentConfigUpdate` below (a write-only credential field, same pattern a
 * password-change form uses: you can set it, never read the current
 * value back). */
export interface AgentConfigPublic {
  ic_sql_canister_id: [] | [Principal];
  admin_webhook_url: [] | [string];
  system_prompt: [] | [string];
  llm_provider: [] | [string];
  max_tool_iterations: [] | [number];
  connector_principal: [] | [Principal];
  llm_model: [] | [string];
}

/** `update_config`'s argument - three states per field, identical
 * semantics to `candid/connector.ts`'s own `ConfigUpdate` doc comment:
 * outer `[]` ("not mentioned") leaves the field untouched, `[[]]` clears
 * it, `[[value]]` sets it. */
export interface AgentConfigUpdate {
  ic_sql_canister_id: [] | [[] | [Principal]];
  admin_webhook_url: [] | [[] | [string]];
  system_prompt: [] | [[] | [string]];
  admin_webhook_secret: [] | [[] | [string]];
  llm_provider: [] | [[] | [string]];
  max_tool_iterations: [] | [[] | [number]];
  llm_api_key: [] | [[] | [string]];
  connector_principal: [] | [[] | [Principal]];
  llm_model: [] | [[] | [string]];
}

export interface IncomingMessage {
  session_id: string;
  text: string;
  channel: Channel;
}

export interface AgentService {
  get_config: () => Promise<{ Ok: AgentConfigPublic } | { Err: string }>;
  update_config: (update: AgentConfigUpdate) => Promise<{ Ok: null } | { Err: string }>;
  get_conversation: (channel: Channel, session_id: string) => Promise<{ Ok: ConversationState } | { Err: string }>;
  receive_message: (msg: IncomingMessage) => Promise<{ Ok: null } | { Err: string }>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Channel = IDL.Variant({ Email: IDL.Null, WhatsApp: IDL.Null, Telegram: IDL.Null });
  const Role = IDL.Variant({ User: IDL.Null, Assistant: IDL.Null });
  const StoredChatMessage = IDL.Record({ at: IDL.Nat64, content: IDL.Text, role: Role });
  const ConversationState = IDL.Record({ history: IDL.Vec(StoredChatMessage) });
  // The real candid record also has `llm_api_key`/`admin_webhook_secret` -
  // deliberately left out of this decode shape (see `AgentConfigPublic`'s
  // own doc comment). `@icp-sdk/core`'s candid decoder only reads the
  // fields an `IDL.Record` declares, so omitting them here means the raw
  // secret bytes are never even parsed into a JS value, not just hidden
  // from render.
  const AgentConfigPublic = IDL.Record({
    ic_sql_canister_id: IDL.Opt(IDL.Principal),
    admin_webhook_url: IDL.Opt(IDL.Text),
    system_prompt: IDL.Opt(IDL.Text),
    llm_provider: IDL.Opt(IDL.Text),
    max_tool_iterations: IDL.Opt(IDL.Nat8),
    connector_principal: IDL.Opt(IDL.Principal),
    llm_model: IDL.Opt(IDL.Text),
  });
  const AgentConfigUpdate = IDL.Record({
    ic_sql_canister_id: IDL.Opt(IDL.Opt(IDL.Principal)),
    admin_webhook_url: IDL.Opt(IDL.Opt(IDL.Text)),
    system_prompt: IDL.Opt(IDL.Opt(IDL.Text)),
    admin_webhook_secret: IDL.Opt(IDL.Opt(IDL.Text)),
    llm_provider: IDL.Opt(IDL.Opt(IDL.Text)),
    max_tool_iterations: IDL.Opt(IDL.Opt(IDL.Nat8)),
    llm_api_key: IDL.Opt(IDL.Opt(IDL.Text)),
    connector_principal: IDL.Opt(IDL.Opt(IDL.Principal)),
    llm_model: IDL.Opt(IDL.Opt(IDL.Text)),
  });
  const IncomingMessage = IDL.Record({ session_id: IDL.Text, text: IDL.Text, channel: Channel });
  const ConfigResult = IDL.Variant({ Ok: AgentConfigPublic, Err: IDL.Text });
  const ConversationResult = IDL.Variant({ Ok: ConversationState, Err: IDL.Text });
  const UnitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return IDL.Service({
    get_config: IDL.Func([], [ConfigResult], ["query"]),
    update_config: IDL.Func([AgentConfigUpdate], [UnitResult], []),
    get_conversation: IDL.Func([Channel, IDL.Text], [ConversationResult], ["query"]),
    receive_message: IDL.Func([IncomingMessage], [UnitResult], []),
  });
};
