// Hand-written mirror of the real `connector` building block's config/stats
// surface (see `packages/connector/connector.did`) - `get_config` is
// controller-only on the real canister (`packages/connector/src/lib.rs::
// require_controller`), which the real signed-in user genuinely is for
// every connector canister this dashboard deployed for them (same
// `per-user-canister-ownership` reasoning `candid/auth.ts`'s own doc
// comment describes), so this call works for real, not just in principle.
// `get_stats`/`llm_context` are open to any caller on the real canister -
// see `connector.did`'s own doc comments on why (an aggregate message
// count/self-description isn't sensitive the way stored message content or
// channel credentials are).

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import type { ConnectorStats } from "./buildingBlock";

/** Deliberately omits every real credential field `Config` actually has
 * (`telegram_bot_token`, `telegram_secret_token`, `mail_bridge_api_key`,
 * `whatsapp_access_token`, `whatsapp_verify_token`, `whatsapp_app_secret`) -
 * nothing here should ever put a real webhook/API secret on screen. What's
 * left is genuinely useful for an "Agent page" Connectors tab without being
 * sensitive: which agent canister this connector forwards to, which
 * principal may send through it, and the non-secret channel identifiers
 * (phone number id, mail_bridge principal/url/from-address). */
export interface ConnectorConfigPublic {
  agent_canister: [] | [Principal];
  authorized_sender: [] | [Principal];
  mail_bridge_principal: [] | [Principal];
  mail_bridge_url: [] | [string];
  mail_from_address: [] | [string];
  whatsapp_phone_number_id: [] | [string];
}

/** A deliberately minimal slice of the real `ConfigUpdate` - just the one
 * field the Agent Map ever needs to write. Every field on the real
 * `ConfigUpdate` is independently three-state (`[]` not-mentioned/leave
 * alone, `[[]]` clear, `[[value]]` set - see `agentCanister.ts`'s own doc
 * comment on the identical convention), so a real canister update need
 * only ever *declare* the fields it's actually changing: an omitted
 * `opt`-typed record field decodes as `[]` on the Rust side exactly as if
 * this type had listed it explicitly - real Candid record-subtyping, not
 * an approximation. This means writing `agent_canister` here can never
 * accidentally touch any of the six credential fields this file's own
 * `ConnectorConfigPublic` deliberately never even reads. */
export interface ConnectorAgentWireUpdate {
  agent_canister: [] | [[] | [Principal]];
}

export interface ConnectorService {
  get_config: () => Promise<{ Ok: ConnectorConfigPublic } | { Err: string }>;
  get_stats: () => Promise<ConnectorStats>;
  update_config: (update: ConnectorAgentWireUpdate) => Promise<{ Ok: null } | { Err: string }>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  // The real candid record also has six credential fields - deliberately
  // left out of this decode shape (see `ConnectorConfigPublic`'s own doc
  // comment). `@icp-sdk/core`'s candid decoder only reads the fields an
  // `IDL.Record` declares, so omitting them here means the raw secret
  // bytes are never even parsed into a JS value, not just hidden from
  // render.
  const ConnectorConfigPublic = IDL.Record({
    agent_canister: IDL.Opt(IDL.Principal),
    authorized_sender: IDL.Opt(IDL.Principal),
    mail_bridge_principal: IDL.Opt(IDL.Principal),
    mail_bridge_url: IDL.Opt(IDL.Text),
    mail_from_address: IDL.Opt(IDL.Text),
    whatsapp_phone_number_id: IDL.Opt(IDL.Text),
  });
  const ConnectorStats = IDL.Record({ messages_processed: IDL.Nat64 });
  const ConnectorAgentWireUpdate = IDL.Record({ agent_canister: IDL.Opt(IDL.Opt(IDL.Principal)) });
  const ConfigResult = IDL.Variant({ Ok: ConnectorConfigPublic, Err: IDL.Text });
  const UnitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return IDL.Service({
    get_config: IDL.Func([], [ConfigResult], ["query"]),
    get_stats: IDL.Func([], [ConnectorStats], ["query"]),
    update_config: IDL.Func([ConnectorAgentWireUpdate], [UnitResult], []),
  });
};
