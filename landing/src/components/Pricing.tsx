import { Fuel, Store, KeyRound } from "lucide-react";
import { Container, SectionHeading, Card } from "./ui";

const POINTS = [
  {
    icon: Fuel,
    title: "Gas & Fuel",
    description:
      "Fuel your own canisters directly with ICP. Every action they take burns a little gas - priced by the compute, memory, and storage it actually touches - nothing marked up, nothing idle costing you anything beyond its own footprint.",
  },
  {
    icon: Store,
    title: "Marketplace items",
    description:
      "Most building blocks are free. Paid ones are priced once by their own publisher, in ICP - you buy directly from them. CanisterHub doesn't take a cut or add a markup of its own.",
  },
  {
    icon: KeyRound,
    title: "Your business, your keys",
    description:
      "There's no CanisterHub subscription to manage and no seat count to track. Stop adding fuel and your canisters simply pause - nothing you've built is ever held hostage.",
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="py-20 sm:py-28 border-t border-[#1e2d47] bg-[#0f1629]">
      <Container className="space-y-14">
        <SectionHeading
          eyebrow="Pricing"
          title="No plans. No per-seat fees. Just gas."
          subtitle="CanisterHub doesn't mark up compute or lock features behind a tier. You fuel your own canisters directly and pay only the gas they actually burn - the same model the whole Internet Computer runs on."
        />

        <div className="grid sm:grid-cols-3 gap-5">
          {POINTS.map((point) => (
            <Card key={point.title}>
              <div className="w-10 h-10 rounded-lg bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center mb-4">
                <point.icon size={18} className="text-[#00d4ff]" />
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
