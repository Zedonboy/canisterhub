// In-memory stand-in for the agent canister, enabled with VITE_MOCK=1
// (`npm run dev:mock`). Lets the UI be explored without a backend.

import type { ChannelName, ChatMessage, Conversation, SenderRole } from "./chat";

const MIN = 60_000;
const now = Date.now();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Thread = { channel: ChannelName; sessionId: string; displayName: string | null; msgs: [SenderRole, string, number][] };

const threads: Thread[] = [
  { channel: "WhatsApp", sessionId: "+2348031234567", displayName: "Amaka O.", msgs: [
    ["customer", "Hi, do you still have the 5kg laundry bundle?", 95 * MIN],
    ["agent", "Hello Amaka! Yes, the 5kg bundle is available at ₦6,500 with next-day pickup. Want me to book it?", 94 * MIN],
    ["customer", "Yes please, pickup tomorrow 9am at 14 Allen Avenue", 20 * MIN],
    ["agent", "Booked ✅ Order #1042: 5kg bundle, pickup tomorrow 9:00 at 14 Allen Avenue.", 19 * MIN],
  ]},
  { channel: "Telegram", sessionId: "552019384", displayName: "@tunde_b", msgs: [
    ["customer", "where is my order 1038??", 8 * MIN],
    ["agent", "Order #1038 is out for delivery and should arrive within 40 minutes.", 7 * MIN],
    ["customer", "its been 2 hours, this is not ok", 3 * MIN],
  ]},
  { channel: "Email", sessionId: "chioma@example.com", displayName: "Re: Bulk order quote", msgs: [
    ["customer", "Hello, we need a quote for 40 shirts weekly for our office.", 60 * 26 * MIN],
    ["agent", "Thanks Chioma! Weekly volume of 40 shirts qualifies for our business rate of ₦900/shirt. I've flagged this for the owner to confirm.", 60 * 26 * MIN - MIN],
    ["operator", "Hi Chioma, confirmed — ₦850/shirt on a 3-month contract. I'll send the agreement today.", 60 * 24 * MIN],
  ]},
  { channel: "Web", sessionId: "8f1c2a7e-3b0d-4e55-9c1a-77d2e0a1b9aa", displayName: null, msgs: [
    ["customer", "Do you deliver to Lekki?", 2 * 24 * 60 * MIN],
    ["agent", "Yes! Lekki is covered, delivery fee ₦1,000.", 2 * 24 * 60 * MIN - MIN],
  ]},
];

const consoleMsgs: [SenderRole, string, number][] = [
  ["customer", "How many orders came in today?", 120 * MIN],
  ["agent", "7 orders today (₦48,200 total). 2 are still awaiting pickup.", 120 * MIN - 5_000],
];

const webSession: [SenderRole, string, number][] = [];

function toMsgs(m: [SenderRole, string, number][]): ChatMessage[] {
  return m.map(([role, text, ago], index) => ({ index, role, text, at: now - ago }));
}
const key = (c: ChannelName, s: string) => threads.find((t) => t.channel === c && t.sessionId === s);

export const mock = {
  async listConversations(): Promise<Conversation[]> {
    await delay(200);
    return threads
      .map((t) => {
        const last = t.msgs[t.msgs.length - 1];
        return { channel: t.channel, sessionId: t.sessionId, displayName: t.displayName, lastText: last[1], lastRole: last[0], lastAt: now - last[2], messageCount: t.msgs.length };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
  },
  async getMessages(c: ChannelName, s: string) {
    await delay(150);
    return toMsgs(key(c, s)?.msgs ?? []);
  },
  async sendOperatorReply(c: ChannelName, s: string, text: string) {
    await delay(400);
    key(c, s)?.msgs.push(["operator", text, -(Date.now() - now)]);
  },
  async getConsoleMessages() {
    await delay(150);
    return toMsgs(consoleMsgs);
  },
  async sendToAgent(text: string) {
    consoleMsgs.push(["customer", text, -(Date.now() - now)]);
    await delay(1800);
    consoleMsgs.push(["agent", "Got it — (mock reply) I'll look into that and report back.", -(Date.now() - now)]);
  },
  async webSend(text: string) {
    await delay(1800);
    webSession.push(["customer", text, -(Date.now() - now)]);
    webSession.push(["agent", "Thanks for reaching out! (mock reply) A team member can confirm details shortly.", -(Date.now() - now)]);
  },
  async webMessages(after: number) {
    await delay(100);
    return toMsgs(webSession).slice(after);
  },
};
