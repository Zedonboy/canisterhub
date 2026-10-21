import { Boxes } from "lucide-react";
import { Container } from "./ui";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Platform", href: "#platform" },
      { label: "AI Agents", href: "#agents" },
      { label: "Marketplace", href: "#marketplace" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    heading: "Developers",
    links: [
      { label: "Documentation", href: "#" },
      { label: "GitHub", href: "#" },
      { label: "Publish a package", href: "#" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Contact sales", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-[#1e2d47] py-12">
      <Container className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10">
        <div className="space-y-3">
          <div className="flex items-center gap-2 font-semibold text-[#e2e8f0]">
            <Boxes size={18} className="text-[#00d4ff]" />
            CanisterHub
          </div>
          <p className="text-sm text-[#4a5568] max-w-xs">
            The compute platform for businesses running on the Internet Computer.
          </p>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.heading} className="space-y-3">
            <h4 className="text-xs font-semibold text-[#8892a4] uppercase tracking-wider">{col.heading}</h4>
            <ul className="space-y-2">
              {col.links.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-sm text-[#4a5568] hover:text-[#e2e8f0] transition-colors">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Container>

      <Container className="mt-10 pt-6 border-t border-[#1e2d47] text-xs text-[#4a5568]">
        © {new Date().getFullYear()} CanisterHub. Running on the Internet Computer.
      </Container>
    </footer>
  );
}
