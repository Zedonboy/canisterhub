import { useState } from "react";
import { Boxes, Menu, X } from "lucide-react";
import { Container, ButtonLink } from "./ui";

const LINKS = [
  { href: "#platform", label: "Platform" },
  { href: "#agents", label: "AI Agents" },
  { href: "#marketplace", label: "Marketplace" },
  { href: "#pricing", label: "Pricing" },
];

export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-[#1e2d47] bg-[#0a0e1acc] backdrop-blur-md">
      <Container className="flex items-center justify-between h-16">
        <a href="#top" className="flex items-center gap-2 font-semibold text-[#e2e8f0]">
          <Boxes size={20} className="text-[#00d4ff]" />
          CanisterHub
        </a>

        <nav className="hidden md:flex items-center gap-8 text-sm text-[#8892a4]">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-[#e2e8f0] transition-colors">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:flex items-center">
          <ButtonLink variant="primary" size="md">Launch Dashboard</ButtonLink>
        </div>

        <button className="md:hidden text-[#e2e8f0]" onClick={() => setOpen((v) => !v)} aria-label="Toggle menu">
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </Container>

      {open && (
        <div className="md:hidden border-t border-[#1e2d47] bg-[#0a0e1a] px-4 py-4 space-y-4">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="block text-sm text-[#8892a4] hover:text-[#e2e8f0]" onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
          <div className="pt-2">
            <ButtonLink variant="primary" size="md" className="w-full">Launch Dashboard</ButtonLink>
          </div>
        </div>
      )}
    </header>
  );
}
