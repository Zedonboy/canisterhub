import { Store, Wrench, LineChart } from "lucide-react";
import { Container, SectionHeading, Card } from "./ui";

const AUDIENCE = [
  {
    icon: Store,
    title: "Running a growing business",
    description: "You need a website, a booking or ordering system, and a way to see what's actually happening — not a server rack.",
  },
  {
    icon: Wrench,
    title: "Not a full engineering team",
    description: "CanisterHub's dashboard and Secretary are built so a non-technical owner can launch and manage real infrastructure directly.",
  },
  {
    icon: LineChart,
    title: "Tired of unpredictable bills",
    description: "Usage-based compute, no egress fees, and a reverse-gas model that means your customers never pay a cent to use your app.",
  },
];

export function ForSmes() {
  return (
    <section className="py-20 sm:py-28 border-t border-[#1e2d47] bg-[#0f1629]">
      <Container className="space-y-14">
        <SectionHeading
          eyebrow="Built for business owners"
          title="You don't need to be a blockchain developer"
          subtitle="CanisterHub was designed for the owner who needs their digital business to just work — sign in, describe what you need, and launch. The protocol complexity stays out of your way."
        />

        <div className="grid sm:grid-cols-3 gap-5">
          {AUDIENCE.map((item) => (
            <Card key={item.title}>
              <div className="w-10 h-10 rounded-lg bg-[#00e67611] border border-[#00e67633] flex items-center justify-center mb-4">
                <item.icon size={18} className="text-[#00e676]" />
              </div>
              <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">{item.title}</h3>
              <p className="text-sm text-[#8892a4] leading-relaxed">{item.description}</p>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}
