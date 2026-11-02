import { ArrowRight } from "lucide-react";
import { Container, ButtonLink } from "./ui";

export function Cta() {
  return (
    <section className="py-20 sm:py-28 border-t border-[#1e2d47] relative overflow-hidden">
      <div className="absolute inset-0 hero-glow" />
      <Container className="relative flex flex-col items-center text-center gap-6">
        <h2 className="text-3xl sm:text-5xl font-bold tracking-tight max-w-2xl">
          Ready to run your business <span className="gradient-text">on-chain</span>?
        </h2>
        <p className="text-base text-[#8892a4] max-w-xl">
          Sign in with Internet Identity, describe what your business needs, and have a real canister running in
          minutes.
        </p>
        <ButtonLink variant="primary" size="lg" className="gap-2">
          Launch Dashboard <ArrowRight size={16} />
        </ButtonLink>
      </Container>
    </section>
  );
}
