import { Cpu, Database, ShieldCheck, Sparkles, Store, BarChart3 } from "lucide-react";
import { Container, SectionHeading, Card } from "./ui";

const FEATURES = [
  {
    icon: Cpu,
    title: "Compute runtime",
    description: "Deploy any canister wasm, upgrade it safely, and host your backend without racking a single server.",
  },
  {
    icon: Database,
    title: "Instant database",
    description: "On-chain, tamper-proof data storage with the reliability of a managed database and none of the maintenance.",
  },
  {
    icon: ShieldCheck,
    title: "Built-in authentication",
    description: "Internet Identity out of the box — secure sign-in for your customers, with no password table to ever leak.",
  },
  {
    icon: Sparkles,
    title: "Agentic tools",
    description: "Describe what you need in plain English; your AI Secretary writes, tests, and deploys it for you.",
  },
  {
    icon: Store,
    title: "Marketplace",
    description: "Install vetted, reusable building blocks — billing, scheduling, search — instead of building from scratch.",
  },
  {
    icon: BarChart3,
    title: "Real analytics",
    description: "Every metric comes straight from your own canisters — not a vendor's dashboard standing between you and your data.",
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
