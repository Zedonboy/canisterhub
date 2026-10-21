// Hand-written mirrors of the building-block `.did` surfaces the dashboard
// calls directly for business-level stats and self-description - the
// direct replacement for the orchestrator's old
// `routes::jobs::business_stats_for`/`generate_llm_context`'s own
// `icp canister call` shelling (see the architecture plan this
// implements). Only `connector`/`agent` expose `get_stats` (see
// `packages/connector/connector.did` / `packages/agent/agent.did`
// - `admin_agent`/`auth` don't; matches
// `orchestrator::job::CanisterKind`'s own doc comment on why); every real
// kind that has one exposes the same `llm_context : () -> (text) query`.

import { IDL } from "@icp-sdk/core/candid";

export interface ConnectorStats {
  messages_processed: bigint;
}

export interface AgentStats {
  messages_out: bigint;
  completion_tokens: bigint;
  messages_in: bigint;
  prompt_tokens: bigint;
}

/** Every real kind that exposes one shares this exact shape - see this
 * file's own doc comment. */
export const llmContextIdlFactory: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    llm_context: IDL.Func([], [IDL.Text], ["query"]),
  });

export const connectorIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const ConnectorStats = IDL.Record({ messages_processed: IDL.Nat64 });
  return IDL.Service({
    get_stats: IDL.Func([], [ConnectorStats], ["query"]),
    llm_context: IDL.Func([], [IDL.Text], ["query"]),
  });
};

export const agentIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const AgentStats = IDL.Record({ messages_out: IDL.Nat64, completion_tokens: IDL.Nat64, messages_in: IDL.Nat64, prompt_tokens: IDL.Nat64 });
  return IDL.Service({
    get_stats: IDL.Func([], [AgentStats], ["query"]),
    llm_context: IDL.Func([], [IDL.Text], ["query"]),
  });
};
