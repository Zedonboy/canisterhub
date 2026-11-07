// A static mockup of the real dashboard's Overview page - same card layout,
// status-dot colors, and canister-kind labels as frontend/src/pages/Overview.tsx
// and frontend/src/components/StatusDot.tsx, just hardcoded sample data
// instead of a live project. Not a live component: no state, no canister
// calls, nothing here is real - it exists purely to show a visitor what
// they land in after "Launch Dashboard", not to demonstrate functionality.

interface SampleCanister {
  name: string;
  kind: string;
  id: string;
  memory: string;
  cycles: string;
  status: "healthy" | "degraded";
}

const SAMPLE_CANISTERS: SampleCanister[] = [
  { name: "secretary", kind: "Agent", id: "x7k2q-fqaaa-aaaah-qcai", memory: "18.4 MB", cycles: "2.1T", status: "healthy" },
  { name: "customer-db", kind: "Database", id: "a4f9x-2iaaa-aaaah-qcai", memory: "42.1 MB", cycles: "4.6T", status: "healthy" },
  { name: "luna-shop", kind: "Static", id: "bq3n1-8yaaa-aaaah-qcai", memory: "6.2 MB", cycles: "0.8T", status: "healthy" },
  { name: "payments", kind: "Connector", id: "m8r5t-vaaaa-aaaah-qcai", memory: "11.9 MB", cycles: "1.4T", status: "healthy" },
];

function StatusDot({ status }: { status: "healthy" | "degraded" }) {
  const color = status === "healthy" ? "bg-[#00e676]" : "bg-[#ffab40]";
  return (
    <span className="relative inline-flex flex-shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
      <span className={`absolute inset-0 rounded-full animate-pulse-dot opacity-50 ${color}`} />
    </span>
  );
}

export function DashboardPreview() {
  return (
    <div className="w-full max-w-2xl rounded-xl border border-[#1e2d47] bg-[#0f1629] text-left overflow-hidden mt-4 shadow-2xl">
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[#1e2d47] bg-[#0a0e1a]">
        <span className="w-2.5 h-2.5 rounded-full bg-[#ff5252]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#ffab40]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#00e676]" />
        <span className="ml-3 px-3 py-1 rounded-md bg-[#131929] text-[11px] text-[#4a5568] font-mono truncate">
          dashboard.canisterhub.io/lunas-kitchen
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] text-[#00d4ff] font-medium tracking-wide">Welcome back</p>
            <h3 className="text-sm font-semibold text-[#e2e8f0]">Luna's Kitchen</h3>
          </div>
          <span className="text-[10px] px-2.5 py-1.5 rounded-md bg-[#00d4ff] text-[#0a0e1a] font-medium whitespace-nowrap">
            + Deploy
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {SAMPLE_CANISTERS.map((c) => (
            <div key={c.name} className="p-2.5 rounded-lg bg-[#0a0e1a] border border-[#1e2d47] space-y-1.5">
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[11px] font-medium text-[#e2e8f0] truncate">{c.name}</span>
                <StatusDot status={c.status} />
              </div>
              <div className="text-[9px] text-[#4a5568] uppercase tracking-wide">{c.kind}</div>
              <div className="text-[9px] text-[#4a5568] font-mono truncate">{c.id}</div>
              <div className="text-[9px] text-[#4a5568]">
                {c.memory} · {c.cycles} gas
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
