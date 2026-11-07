// Thin typed wrappers over the actor - unwrap `Result`, normalize shapes.

import { mock } from "./mock";
import { getAgentActor, getCustomerActor } from "./agentActor";
import {
  CONSOLE_CHANNEL,
  CONSOLE_SESSION,
  type Channel,
  type AdminRequest as RawAdminRequest,
  type ClientDataRequest,
  type ClientDataValue,
  type ConversationSummary,
  type Result,
  type StoredChatMessage,
} from "./candid/agentChat";

export type ChannelName = "WhatsApp" | "Telegram" | "Email" | "Web";
export type SenderRole = "customer" | "agent" | "operator";

export interface ChatMessage {
  /** Stable within one conversation: index in the history array. */
  index: number;
  role: SenderRole;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface Conversation {
  channel: ChannelName;
  sessionId: string;
  displayName: string | null;
  lastText: string;
  lastRole: SenderRole;
  lastAt: number;
  messageCount: number;
}

export type TicketStatus = "Pending" | "Approved" | "Rejected" | "Completed";

export interface Ticket {
  id: number;
  channel: ChannelName;
  sessionId: string;
  actionType: string;
  details: string;
  status: TicketStatus;
  resultMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

const MOCK = import.meta.env.VITE_MOCK === "1";

export const CHANNELS: ChannelName[] = ["WhatsApp", "Telegram", "Email", "Web"];

export function channelName(c: Channel): ChannelName {
  return Object.keys(c)[0] as ChannelName;
}

export function channelValue(name: ChannelName): Channel {
  return { [name]: null } as Channel;
}

function roleOf(r: StoredChatMessage["role"]): SenderRole {
  if ("User" in r) return "customer";
  if ("Operator" in r) return "operator";
  return "agent";
}

function nsToMs(ns: bigint): number {
  return Number(ns / 1_000_000n);
}

function unwrap<T>(r: Result<T>): T {
  if ("Err" in r) throw new Error(r.Err);
  return r.Ok;
}

function toMessages(history: StoredChatMessage[], startIndex = 0): ChatMessage[] {
  return history.map((m, i) => ({ index: startIndex + i, role: roleOf(m.role), text: m.content, at: nsToMs(m.at) }));
}

function toConversation(s: ConversationSummary): Conversation {
  return {
    channel: channelName(s.channel),
    sessionId: s.session_id,
    displayName: s.display_name[0] ?? null,
    lastText: s.last_text,
    lastRole: roleOf(s.last_role),
    lastAt: nsToMs(s.last_at),
    messageCount: Number(s.message_count),
  };
}

function toTicket(ticket: RawAdminRequest): Ticket {
  return {
    id: Number(ticket.id),
    channel: channelName(ticket.channel),
    sessionId: ticket.session_id,
    actionType: ticket.action_type,
    details: ticket.details,
    status: Object.keys(ticket.status)[0] as TicketStatus,
    resultMessage: ticket.result_message[0] ?? null,
    createdAt: nsToMs(ticket.created_at),
    updatedAt: nsToMs(ticket.updated_at),
  };
}

// ---- SME side -------------------------------------------------------------

export async function listConversations(limit = 200): Promise<Conversation[]> {
  if (MOCK) return mock.listConversations();
  const actor = await getAgentActor();
  return unwrap(await actor.list_conversations(0n, BigInt(limit))).map(toConversation);
}

export async function listTickets(limit = 200): Promise<Ticket[]> {
  if (MOCK) return mock.listTickets();
  const actor = await getAgentActor();
  return unwrap(await actor.list_admin_requests(0n, BigInt(limit))).map(toTicket);
}

export async function completeTicket(id: number): Promise<Ticket> {
  if (MOCK) return mock.completeTicket(id);
  const actor = await getAgentActor();
  return toTicket(unwrap(await actor.complete_admin_request(BigInt(id))));
}

export async function getMessages(channel: ChannelName, sessionId: string): Promise<ChatMessage[]> {
  if (MOCK) return mock.getMessages(channel, sessionId);
  const actor = await getAgentActor();
  return toMessages(unwrap(await actor.get_conversation(channelValue(channel), sessionId)).history);
}

export async function sendOperatorReply(channel: ChannelName, sessionId: string, text: string): Promise<void> {
  if (MOCK) return mock.sendOperatorReply(channel, sessionId, text);
  const actor = await getAgentActor();
  unwrap(await actor.operator_reply(channelValue(channel), sessionId, text));
}

export async function getConsoleMessages(): Promise<ChatMessage[]> {
  if (MOCK) return mock.getConsoleMessages();
  const actor = await getAgentActor();
  return toMessages(unwrap(await actor.get_conversation(CONSOLE_CHANNEL, CONSOLE_SESSION)).history);
}

export async function sendToAgent(text: string): Promise<void> {
  if (MOCK) return mock.sendToAgent(text);
  const actor = await getAgentActor();
  unwrap(await actor.console_message(text));
}

// ---- Customer (web channel, signed in with Internet Identity) -------------------------------------

/** `displayName` is always sent (empty clears it), so the inbox label follows
 * what the browser currently holds. */
export async function webSend(text: string, displayName: string): Promise<void> {
  if (MOCK) return mock.webSend(text);
  const actor = await getCustomerActor();
  unwrap(await actor.web_send(text, [displayName]));
}

export async function webMessages(after: number): Promise<ChatMessage[]> {
  if (MOCK) return mock.webMessages(after);
  const actor = await getCustomerActor();
  return toMessages(unwrap(await actor.web_messages(BigInt(after))), after);
}

export async function webPendingClientData(): Promise<ClientDataRequest | null> {
  if (MOCK) return null;
  const actor = await getCustomerActor();
  return unwrap(await actor.web_pending_client_data())[0] ?? null;
}

export async function webSubmitClientData(
  requestId: bigint,
  value: ClientDataValue,
  displayName: string,
): Promise<void> {
  if (MOCK) return;
  const actor = await getCustomerActor();
  unwrap(await actor.web_submit_client_data(requestId, value, [displayName]));
}
