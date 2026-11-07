import { Cpu, Database, KeyRound, Sparkles, Store, LayoutDashboard } from "lucide-react";
import { Container, SectionHeading, Card } from "./ui";

const FEATURES = [
  {
    icon: Cpu,
    title: "Compute runtime",
    description: "Deploy any canister wasm, upgrade it safely, and host your backend without racking a single server — the protocol replicates and runs it for you.",
  },
  {
    icon: Database,
    title: "Real databases on-chain",
    description: "A PostgreSQL-dialect SQL database with a PostgREST-compatible API and row-level security, plus key-value and vector-search stores — durable storage that survives upgrades.",
  },
  {
    icon: KeyRound,
    title: "Sign in with Google or Internet Identity",
    description: "The auth canister gives your customers OAuth sign-in (Google, GitHub, any provider) or a principal-native IC identity — one profile either way, and no password table to ever leak.",
  },
  {
    icon: Sparkles,
    title: "AI Secretary",
    description: "An agent that runs your business over WhatsApp, Telegram, email, or an embeddable web chat — calling the real tools your canisters expose, with your own LLM key or managed AI.",
  },
  {
    icon: Store,
    title: "Marketplace",
    description: "Install vetted building blocks instead of writing from zero: food ordering, inventory & orders, Kora/Paystack payments, SQL and vector databases, asset storage, and more.",
  },
  {
    icon: LayoutDashboard,
    title: "Admin panels built in",
    description: "Every package serves its own certified admin UI from inside its canister — order boards, menus, payment logs, a table browser. One dashboard sign-in reaches all of them.",
  },
];

export function Features() {
  return (
    <section id="platform" className="py-20 sm:py-28 border-t border-[#1e2d47]">
      <Container className="space-y-14">
        <SectionHeading
          eyebrow="The Platform"
          title="Everything your business needs to run, in one place"
          subtitle="CanisterHub bundles the pieces every digital business needs — compute, data, identity, and AI — so you assemble a real product instead of stitching together five vendors."
        />

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="hover:border-[#00d4ff44] transition-colors">
              <div className="w-10 h-10 rounded-lg bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center mb-4">
                <feature.icon size={18} className="text-[#00d4ff]" />
              </div>
              <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">{feature.title}</h3>
              <p className="text-sm text-[#8892a4] leading-relaxed">{feature.description}</p>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}
