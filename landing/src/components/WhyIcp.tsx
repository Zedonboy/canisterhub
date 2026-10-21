import { X, Check } from "lucide-react";
import { Container, SectionHeading } from "./ui";

const ROWS = [
  { label: "Who pays for usage", cloud: "You pay for every request, plus egress", icp: "Reverse gas model — your customers transact for free" },
  { label: "Data integrity", cloud: "Trust the provider's backups", icp: "Cryptographically verifiable, tamper-proof by design" },
  { label: "Operations", cloud: "Patch servers, rotate secrets, manage uptime", icp: "No servers to patch — the protocol handles replication" },
  { label: "Vendor lock-in", cloud: "Proprietary APIs tie you to one provider", icp: "Open, candid-based interfaces — your canister, your rules" },
  { label: "Billing surprises", cloud: "Usage spikes mean surprise invoices", icp: "Pay only for the gas you actually burn" },
];

export function WhyIcp() {
  return (
    <section className="py-20 sm:py-28 border-t border-[#1e2d47]">
      <Container className="space-y-14">
        <SectionHeading
          eyebrow="Why the Internet Computer"
          title="Enterprise-grade infrastructure. None of the enterprise overhead."
          subtitle="Traditional cloud gave businesses scale, at the cost of complexity and lock-in. The Internet Computer gives you the same reliability with a fundamentally simpler operating model."
        />

        <div className="overflow-x-auto rounded-xl border border-[#1e2d47]">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-[#1e2d47] bg-[#0f1629]">
                <th className="text-left font-medium text-[#8892a4] px-5 py-3.5 w-1/3"></th>
                <th className="text-left font-medium text-[#8892a4] px-5 py-3.5">Traditional cloud</th>
                <th className="text-left font-medium text-[#00d4ff] px-5 py-3.5">CanisterHub on ICP</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => (
                <tr key={row.label} className={i % 2 === 0 ? "bg-transparent" : "bg-[#0f162966]"}>
                  <td className="px-5 py-4 font-medium text-[#e2e8f0] align-top">{row.label}</td>
                  <td className="px-5 py-4 text-[#8892a4] align-top">
                    <div className="flex items-start gap-2">
                      <X size={15} className="text-[#ff5252] mt-0.5 flex-shrink-0" />
                      {row.cloud}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[#e2e8f0] align-top">
                    <div className="flex items-start gap-2">
                      <Check size={15} className="text-[#00e676] mt-0.5 flex-shrink-0" />
                      {row.icp}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Container>
    </section>
  );
}
