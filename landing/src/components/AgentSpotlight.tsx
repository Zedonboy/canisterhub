import type { ReactNode } from "react";
import { Check, Bot } from "lucide-react";
import { Container, SectionHeading, ButtonLink } from "./ui";

const POINTS = [
  "It talks to your customers on WhatsApp, Telegram, email, or a web chat embedded in your own website.",
  "It calls the real tools your canisters expose — take an order, check stock, collect a payment — never trusting data the client sends.",
  "Every package is AI-discoverable: the Secretary reads each canister's own context doc and knows what it can do.",
  "Bring your own OpenAI or Anthropic key, or use managed AI with token-credit billing — your data stays in your canisters either way.",
];

export function AgentSpotlight() {
  return (
    <section id="agents" className="py-20 sm:py-28 border-t border-[#1e2d47] bg-[#0f1629]">
      <Container className="grid lg:grid-cols-2 gap-12 items-center">
        <div className="space-y-6">
          <SectionHeading
            align="left"
            eyebrow="AI Agents"
            title="Hire an AI Secretary, not a dev team."
            subtitle="Most SMEs can't justify a full engineering team for every tool they need. CanisterHub's Secretary is the agentic layer that closes that gap — it builds and deploys canisters from a plain-language request, then keeps running the day-to-day: answering customers, taking orders, and chasing payments."
          />
          <ul className="space-y-3">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm text-[#8892a4]">
                <Check size={16} className="text-[#00e676] mt-0.5 flex-shrink-0" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <ButtonLink variant="primary" size="lg">See it in action</ButtonLink>
        </div>

        <div className="rounded-xl border border-[#1e2d47] bg-[#0a0e1a] p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs text-[#4a5568] pb-3 border-b border-[#1e2d47]">
            <Bot size={13} className="text-[#00d4ff]" /> Secretary · WhatsApp
          </div>
          <ChatBubble from="you">
            Do you still have the jollof platter available for pickup around 6pm?
          </ChatBubble>
          <ChatBubble from="agent">
            Yes — 14 left on today's menu. Want me to reserve one for pickup at 6:00 PM? It comes to ₦4,500.
          </ChatBubble>
          <ChatBubble from="agent" status="✓ order placed · pay here: checkout.kora.com/…">
            Done — your order is in the kitchen board. Here's your secure payment link; your receipt comes right back
            to this chat once it clears.
          </ChatBubble>
        </div>
      </Container>
    </section>
  );
}

function ChatBubble({ from, status, children }: { from: "you" | "agent"; status?: string; children: ReactNode }) {
  return (
    <div className={`flex ${from === "you" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed ${
          from === "you" ? "bg-[#00d4ff14] border border-[#00d4ff33] text-[#e2e8f0]" : "bg-[#131929] border border-[#1e2d47] text-[#8892a4]"
        }`}
      >
        {children}
        {status && <div className="mt-1.5 text-[#00e676] text-[11px] font-medium">✓ {status}</div>}
      </div>
    </div>
  );
}
