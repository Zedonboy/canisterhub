import { Package, ShieldCheck, GitBranch } from "lucide-react";
import { Container, SectionHeading, Card } from "./ui";

const POINTS = [
  {
    icon: Package,
    title: "Reusable building blocks",
    description: "Food ordering, inventory & orders, Kora/Paystack payments, SQL and vector databases, asset storage, an AI customer inbox — install a vetted package instead of writing it from zero.",
  },
  {
    icon: ShieldCheck,
    title: "Inspect before you install",
    description: "Every listing carries its real source repo and a wasm hash checked at install time — no black-box binaries.",
  },
  {
    icon: GitBranch,
    title: "Own what you install",
    description: "Packages deploy into your project as your own canisters, under your control, with their admin panels already built in.",
  },
];

export function Marketplace() {
  return (
    <section id="marketplace" className="py-20 sm:py-28 border-t border-[#1e2d47]">
      <Container className="space-y-14">
        <SectionHeading
          eyebrow="Marketplace"
          title="Don't rebuild what already exists"
          subtitle="Browse a catalog of canisters built for the problems real businesses run into — ordering, payments, data, customer chat — and publish your own once you've built something worth sharing."
        />

        <div className="grid sm:grid-cols-3 gap-5">
          {POINTS.map((point) => (
            <Card key={point.title}>
              <div className="w-10 h-10 rounded-lg bg-[#ffab4011] border border-[#ffab4033] flex items-center justify-center mb-4">
                <point.icon size={18} className="text-[#ffab40]" />
              </div>
              <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">{point.title}</h3>
              <p className="text-sm text-[#8892a4] leading-relaxed">{point.description}</p>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}
