// Hand-written mirror of the chat surface of `packages/agent/agent.did`.
//
// Methods marked EXISTING are already in agent.did today. Methods and
// variants marked NEW are what this UI needs the agent canister to gain -
// the exact Candid and behaviour are specified in ../../../README.md
// ("Backend contract").

import { IDL } from "@icp-sdk/core/candid";

/** NEW variant: `Web`. */
export type Channel = { WhatsApp: null } | { Telegram: null } | { Email: null } | { Web: null };
/** NEW variant: `Operator` (a human SME reply, as opposed to the agent's). */
export type Role = { User: null } | { Assistant: null } | { Operator: null };

export interface StoredChatMessage {
  role: Role;
  content: string;
  /** Nanoseconds since the Unix epoch. */
  at: bigint;
}

export interface ConversationState {
  history: StoredChatMessage[];
}

/** NEW */
export interface ConversationSummary {
  channel: Channel;
  session_id: string;
  /** Email subject / Telegram username / etc. when the channel knows one. */
  display_name: [] | [string];
  last_text: string;
  last_role: Role;
  last_at: bigint;
  message_count: bigint;
}

export type Result<T> = { Ok: T } | { Err: string };

export interface AgentChatService {
  /** NEW, controller-only query. Newest conversation first. */
  list_conversations: (offset: bigint, limit: bigint) => Promise<Result<ConversationSummary[]>>;
  /** EXISTING (only gains the `Web` channel). */
  get_conversation: (channel: Channel, session_id: string) => Promise<Result<ConversationState>>;
  /** NEW, controller-only: deliver `text` to the customer over their own
   * channel AND record it in the history as an `Operator` turn. */
  operator_reply: (channel: Channel, session_id: string, text: string) => Promise<Result<null>>;
  /** NEW, controller-only: an SME message addressed to the agent itself.
   * Returns the agent's reply; both turns are recorded under the reserved
   * console conversation (`CONSOLE_CHANNEL` / `CONSOLE_SESSION`). */
  console_message: (text: string) => Promise<Result<string>>;
  /** NEW, any non-anonymous caller (rate limited server-side): a customer
   * message on the web channel. The session is the CALLER'S PRINCIPAL -
   * there is no session id argument. Resolves once the agent has replied. */
  web_send: (text: string, displayName: [] | [string]) => Promise<Result<null>>;
  /** NEW, any non-anonymous caller: the caller's own web conversation,
   * turns after index `after` (a count of messages already seen). */
  web_messages: (after: bigint) => Promise<Result<StoredChatMessage[]>>;
}

export const CONSOLE_CHANNEL: Channel = { Web: null };
export const CONSOLE_SESSION = "__sme_console__";

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Channel = IDL.Variant({ WhatsApp: IDL.Null, Telegram: IDL.Null, Email: IDL.Null, Web: IDL.Null });
  const Role = IDL.Variant({ User: IDL.Null, Assistant: IDL.Null, Operator: IDL.Null });
  const StoredChatMessage = IDL.Record({ at: IDL.Nat64, content: IDL.Text, role: Role });
  const ConversationState = IDL.Record({ history: IDL.Vec(StoredChatMessage) });
  const ConversationSummary = IDL.Record({
    channel: Channel,
    session_id: IDL.Text,
    display_name: IDL.Opt(IDL.Text),
    last_text: IDL.Text,
    last_role: Role,
    last_at: IDL.Nat64,
    message_count: IDL.Nat64,
  });
  const res = <T extends IDL.Type>(t: T) => IDL.Variant({ Ok: t, Err: IDL.Text });
  return IDL.Service({
    list_conversations: IDL.Func([IDL.Nat64, IDL.Nat64], [res(IDL.Vec(ConversationSummary))], ["query"]),
    get_conversation: IDL.Func([Channel, IDL.Text], [res(ConversationState)], ["query"]),
    operator_reply: IDL.Func([Channel, IDL.Text, IDL.Text], [res(IDL.Null)], []),
    console_message: IDL.Func([IDL.Text], [res(IDL.Text)], []),
    web_send: IDL.Func([IDL.Text, IDL.Opt(IDL.Text)], [res(IDL.Null)], []),
    web_messages: IDL.Func([IDL.Nat64], [res(IDL.Vec(StoredChatMessage))], ["query"]),
  });
};
