import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Features } from "./components/Features";
import { AgentSpotlight } from "./components/AgentSpotlight";
import { WhyIcp } from "./components/WhyIcp";
import { ForSmes } from "./components/ForSmes";
import { Marketplace } from "./components/Marketplace";
import { Pricing } from "./components/Pricing";
import { Cta } from "./components/Cta";
import { Footer } from "./components/Footer";

export default function App() {
  return (
    <div className="min-h-screen bg-[#0a0e1a]">
      <Nav />
      <main>
        <Hero />
        <Features />
        <AgentSpotlight />
        <WhyIcp />
        <ForSmes />
        <Marketplace />
        <Pricing />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
