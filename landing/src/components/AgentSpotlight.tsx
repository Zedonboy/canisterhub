import type { ReactNode } from "react";
import { Check, Bot } from "lucide-react";
import { Container, SectionHeading, Button } from "./ui";

const POINTS = [
  "Tell it what your business needs, in plain English — no ticket, no spec document.",
  "It searches the Marketplace first, so you're not paying to rebuild something that already exists.",
  "It writes, compiles, and tests real canister code — then deploys it for real, not a demo sandbox.",
  "You keep the source and the keys. Nothing about your business lives in a vendor's black box.",
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
            subtitle="Most SMEs can't justify a full engineering team for every internal tool they need. CanisterHub's Secretary is the agentic layer that closes that gap — a real orchestration agent that builds and ships working software from a plain-language request."
          />
          <ul className="space-y-3">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm text-[#8892a4]">
                <Check size={16} className="text-[#00e676] mt-0.5 flex-shrink-0" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <Button variant="primary" size="lg">See it in action</Button>
        </div>

        <div className="rounded-xl border border-[#1e2d47] bg-[#0a0e1a] p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs text-[#4a5568] pb-3 border-b border-[#1e2d47]">
            <Bot size={13} className="text-[#00d4ff]" /> Secretary · live session
          </div>
          <ChatBubble from="you">
            I run a small logistics company. I need something that tracks delivery status and lets customers look it
            up by order number.
          </ChatBubble>
          <ChatBubble from="agent">
            Found a close match in the Marketplace: <span className="text-[#00d4ff]">order-tracker</span>. Deploying
            it and wiring it to a new database canister now.
          </ChatBubble>
          <ChatBubble from="agent" status="done">
            Deployed. Your customers can now check status at your tracker's own canister URL — want me to add SMS
            notifications next?
          </ChatBubble>
        </div>
      </Container>
    </section>
  );
}

function ChatBubble({ from, status, children }: { from: "you" | "agent"; status?: "done"; children: ReactNode }) {
  return (
    <div className={`flex ${from === "you" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed ${
          from === "you" ? "bg-[#00d4ff14] border border-[#00d4ff33] text-[#e2e8f0]" : "bg-[#131929] border border-[#1e2d47] text-[#8892a4]"
        }`}
      >
        {children}
        {status === "done" && <div className="mt-1.5 text-[#00e676] text-[11px] font-medium">✓ deployed</div>}
      </div>
    </div>
  );
}
