import { ArrowRight } from "lucide-react";
import { Container, Button, Eyebrow } from "./ui";
import { DashboardPreview } from "./DashboardPreview";

const STATS = [
  { value: "0", label: "servers to patch" },
  { value: "100%", label: "on-chain, verifiable" },
  { value: "$0", label: "paid by your users to transact" },
  { value: "~min", label: "from idea to deployed canister" },
];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden hero-glow">
      <div className="absolute inset-0 dot-grid opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black_40%,transparent_100%)]" />
      <Container className="relative pt-20 pb-16 sm:pt-28 sm:pb-24 flex flex-col items-center text-center gap-8">
        <Eyebrow>Built on the Internet Computer Protocol</Eyebrow>

        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight max-w-3xl leading-[1.1]">
          Run your business <span className="gradient-text">on-chain</span>, not on a rented server.
        </h1>

        <p className="text-lg text-[#8892a4] max-w-2xl leading-relaxed">
          CanisterHub is the compute platform for small and growing businesses: host your website, database, and
          AI agents in tamper-proof canisters on the Internet Computer — no servers to patch, no DevOps hire, no
          surprise cloud bill at the end of the month.
        </p>

        <Button variant="primary" size="lg" className="gap-2">
          Launch Dashboard <ArrowRight size={16} />
        </Button>

        <DashboardPreview />

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-6 pt-12 w-full max-w-3xl">
          {STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-1">
              <dt className="text-2xl sm:text-3xl font-bold text-[#e2e8f0]">{stat.value}</dt>
              <dd className="text-xs text-[#8892a4] text-center">{stat.label}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
