import { useState, useMemo } from "react";
import {
  BarChart2, Activity, Users, Clock, Globe,
  Search, Download, RefreshCw, ChevronRight, ChevronDown,
} from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Table, TableHead, TableBody, Th, Tr, Td } from "@/components/ui/Table";
import { ToastProvider, toast } from "@/components/Toast";
import { MOCK_EVENTS, DAU_DATA, TOP_EVENTS, MOCK_LOGS, type LogEntry } from "@/lib/mock-data";
import { clsx } from "clsx";

function BarChartViz({ data }: { data: { name: string; count: number }[] }) {
  const max = Math.max(...data.map((d) => d.count));
  return (
    <div className="space-y-1.5">
      {data.map((d) => (
        <div key={d.name} className="flex items-center gap-2 text-xs">
          <span className="w-28 text-[#8892a4] truncate flex-shrink-0">{d.name}</span>
          <div className="flex-1 h-4 bg-[#0a0e1a] rounded overflow-hidden">
            <div
              className="h-full bg-[#00d4ff33] hover:bg-[#00d4ff55] transition-colors rounded flex items-center justify-end pr-1"
              style={{ width: `${(d.count / max) * 100}%` }}
            >
              <span className="text-[9px] text-[#00d4ff] font-mono">{d.count.toLocaleString()}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LineChartViz({ data, color: colorProp }: { data: { date: string; value: number }[]; color?: string }) {
  const max = Math.max(...data.map((d) => d.value));
  const min = Math.min(...data.map((d) => d.value));
  const range = max - min || 1;
  const w = 500;
  const h = 80;
  const pad = 4;

  const points = data.map((d, i) => ({
    x: pad + (i / (data.length - 1)) * (w - pad * 2),
    y: pad + ((max - d.value) / range) * (h - pad * 2),
  }));

  const pathD = points.length === 0 ? "" : `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}`;
  const areaD = points.length === 0 ? "" :
    `M ${points[0].x},${h} L ${points.map((p) => `${p.x},${p.y}`).join(" L ")} L ${points[points.length - 1].x},${h} Z`;

  const color = colorProp ?? "#00d4ff";

  return (
    <div className="w-full overflow-hidden">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: "80px" }}>
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#area-grad)" />
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r="2.5" fill={color} className="cursor-pointer">
            <title>{`${data[i].date}: ${data[i].value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-[#4a5568] font-mono mt-1">
        {data.map((d) => (
          <span key={d.date}>{d.date.split(" ")[1] ?? d.date}</span>
        ))}
      </div>
    </div>
  );
}

function OverviewTab() {
  const kpis = [
    { label: "Unique Users (7d)", value: "1,284", icon: () => <Users size={16} />, change: "+18%", up: true },
    { label: "Total Events (7d)", value: "84,291", icon: () => <Activity size={16} />, change: "+12%", up: true },
    { label: "Avg Session Duration", value: "4m 32s", icon: () => <Clock size={16} />, change: "-3%", up: false },
    { label: "Top Page", value: "/dashboard", icon: () => <Globe size={16} />, change: "stable", up: true },
  ];

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((kpi) => (
          <Card key={kpi.label} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#4a5568]">{kpi.icon()}</span>
              <Badge variant={kpi.up ? "green" : "red"}>{kpi.change}</Badge>
            </div>
            <div className="text-xl font-bold text-[#e2e8f0] font-mono">{kpi.value}</div>
            <div className="text-xs text-[#4a5568] mt-1">{kpi.label}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Daily Active Users</CardTitle>
            <div className="flex gap-1.5">
              {["DAU", "WAU", "MAU"].map((t, i) => (
                <button key={t} className={clsx(
                  "text-xs px-2 py-0.5 rounded transition-colors",
                  i === 0 ? "bg-[#00d4ff22] text-[#00d4ff]" : "text-[#4a5568] hover:text-[#8892a4]"
                )}>
                  {t}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <LineChartViz data={DAU_DATA} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Top Events</CardTitle></CardHeader>
          <CardContent>
            <BarChartViz data={TOP_EVENTS} />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle>Device Breakdown</CardTitle></CardHeader>
          <CardContent>
            {[
              { label: "Desktop", pct: 68 },
              { label: "Mobile", pct: 24 },
              { label: "Tablet", pct: 8 },
            ].map((d) => (
              <div key={d.label} className="flex items-center gap-2 mb-2 text-xs">
                <span className="w-16 text-[#8892a4]">{d.label}</span>
                <div className="flex-1 h-3 bg-[#0a0e1a] rounded overflow-hidden">
                  <div className="h-full bg-[#00d4ff33] rounded" style={{ width: `${d.pct}%` }} />
                </div>
                <span className="text-[#8892a4] w-8 text-right">{d.pct}%</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Top Regions</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                ["United States", "34%"],
                ["Germany", "12%"],
                ["Japan", "9%"],
                ["Canada", "8%"],
                ["United Kingdom", "7%"],
                ["Other", "30%"],
              ].map(([region, pct]) => (
                <div key={region} className="flex justify-between text-xs py-1 border-b border-[#162035]">
                  <span className="text-[#8892a4]">{region}</span>
                  <span className="text-[#e2e8f0] font-mono">{pct}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EventsTab() {
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Input placeholder="Search events..." className="flex-1" />
        <Button variant="secondary" size="sm">Filter</Button>
        <Button variant="primary" size="sm">+ Custom Event</Button>
      </div>
      <Table>
        <TableHead>
          <tr>
            <Th>Timestamp</Th>
            <Th>Event</Th>
            <Th>Principal</Th>
            <Th>Properties</Th>
          </tr>
        </TableHead>
        <TableBody>
          {MOCK_EVENTS.map((ev) => (
            <Tr key={ev.timestamp + ev.name}>
              <Td className="font-mono text-xs text-[#4a5568]">{ev.timestamp.replace("T", " ").replace("Z", "")}</Td>
              <Td><Badge variant="cyan">{ev.name}</Badge></Td>
              <Td className="font-mono text-xs text-[#00d4ff]">{ev.principal.slice(0, 12)}…</Td>
              <Td>
                <span className="font-mono text-xs text-[#4a5568] truncate max-w-xs inline-block">
                  {JSON.stringify(ev.properties).slice(0, 60)}…
                </span>
              </Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FunnelsTab() {
  const steps = ["page_view", "button_click", "api_call", "user_login"];
  const counts = [12840, 2891, 8321, 3204];

  return (
    <div className="p-4">
      <Card>
        <CardHeader>
          <CardTitle>Conversion Funnel</CardTitle>
          <Button variant="secondary" size="sm">+ Add Step</Button>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 h-48 mt-4">
            {steps.map((step, i) => {
              const pct = (counts[i] / counts[0]) * 100;
              const conv = i === 0 ? 100 : ((counts[i] / counts[i - 1]) * 100).toFixed(1);
              return (
                <div key={step} className="flex-1 flex flex-col items-center gap-2">
                  <div className="text-xs text-[#8892a4] font-mono">{conv}%</div>
                  <div className="w-full rounded-t flex items-end justify-center bg-[#00d4ff22]"
                    style={{ height: `${pct}%` }}>
                    <span className="text-[10px] text-[#00d4ff] font-mono mb-1">
                      {counts[i].toLocaleString()}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#4a5568] text-center">{step}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RetentionTab() {
  const weeks = ["W1", "W2", "W3", "W4", "W5", "W6"];
  const cohorts = [
    [100, 62, 48, 41, 38, 35],
    [100, 58, 44, 39, 35],
    [100, 65, 51, 43],
    [100, 60, 47],
    [100, 63],
    [100],
  ];

  const heatColor = (pct: number) => {
    if (pct >= 80) return "bg-[#00d4ff] text-[#0a0e1a]";
    if (pct >= 60) return "bg-[#00d4ff88] text-[#e2e8f0]";
    if (pct >= 40) return "bg-[#00d4ff44] text-[#e2e8f0]";
    if (pct >= 20) return "bg-[#00d4ff22] text-[#8892a4]";
    return "bg-[#00d4ff11] text-[#4a5568]";
  };

  return (
    <div className="p-4">
      <Card>
        <CardHeader><CardTitle>Cohort Retention (Weekly)</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-[#4a5568] w-20">Cohort</th>
                  {weeks.map((w) => (
                    <th key={w} className="px-2 py-1 text-center text-[#4a5568] w-12">{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.map((row, ci) => (
                  <tr key={ci}>
                    <td className="px-2 py-1 text-[#8892a4] font-mono">Feb {17 + ci}</td>
                    {row.map((pct, pi) => (
                      <td key={pi} className="px-1 py-1">
                        <div className={clsx("w-10 h-8 rounded flex items-center justify-center font-mono font-bold", heatColor(pct))}>
                          {pct}%
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const LOG_LEVEL_STYLES: Record<string, string> = {
  ERROR: "text-[#ff5252]",
  WARN: "text-[#ffab40]",
  INFO: "text-[#00d4ff]",
  DEBUG: "text-[#4a5568]",
};

const LOG_SERVICES = ["All", "AUTH", "STORAGE", "ANALYTICS", "AGENTS", "CONFIG"];
const LOG_LEVELS = ["All", "ERROR", "WARN", "INFO", "DEBUG"];

function LogLine({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = log.detail && Object.keys(log.detail).length > 0;

  return (
    <div className="border-b border-[#0f1629] last:border-0">
      <button
        className="w-full text-left flex items-start gap-2 py-1.5 px-3 hover:bg-[#131929] transition-colors font-mono text-xs"
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        <span className="text-[#4a5568] flex-shrink-0 hidden sm:block">
          {log.timestamp.replace("T", " ").replace("Z", " UTC")}
        </span>
        <span className={clsx("flex-shrink-0 font-bold w-12 text-center", LOG_LEVEL_STYLES[log.level])}>
          {log.level}
        </span>
        <span className="text-[#00d4ff] flex-shrink-0 w-20">[{log.service}]</span>
        <span className="text-[#8892a4] flex-1 text-left">{log.message}</span>
        {hasDetail && (
          <span className="text-[#4a5568] flex-shrink-0 ml-1">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="mx-3 mb-2 p-2 bg-[#0a0e1a] rounded border border-[#162035] font-mono text-[11px] text-[#4a5568]">
          <pre className="whitespace-pre-wrap">{JSON.stringify(log.detail, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function LogsTab() {
  const [service, setService] = useState("All");
  const [level, setLevel] = useState("All");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(false);

  const filtered = useMemo(() =>
    MOCK_LOGS.filter((log) => {
      if (service !== "All" && log.service !== service) return false;
      if (level !== "All" && log.level !== level) return false;
      if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
    [service, level, search]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[#1e2d47] bg-[#0a0e1a] space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4a5568]" />
            <Input placeholder="Search logs..." className="pl-8 h-8 text-xs" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button
            variant={live ? "primary" : "secondary"}
            size="sm"
            onClick={() => { setLive((v) => !v); if (!live) toast.info("Live streaming enabled"); }}
            className="gap-1.5"
          >
            <span className={clsx("w-1.5 h-1.5 rounded-full", live ? "bg-[#0a0e1a] animate-pulse-dot" : "bg-[#4a5568]")} />
            {live ? "Live" : "Start Live"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.success("Logs downloaded")}>
            <Download size={13} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.info("Refreshed")}>
            <RefreshCw size={13} />
          </Button>
        </div>

        <div className="flex gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[#4a5568]">Service:</span>
            <div className="flex gap-0.5">
              {LOG_SERVICES.map((s) => (
                <button
                  key={s}
                  onClick={() => setService(s)}
                  className={clsx(
                    "px-2 py-0.5 rounded text-xs transition-colors",
                    service === s
                      ? "bg-[#00d4ff22] text-[#00d4ff]"
                      : "text-[#4a5568] hover:text-[#8892a4]"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-[#4a5568]">Level:</span>
            <div className="flex gap-0.5">
              {LOG_LEVELS.map((l) => (
                <button
                  key={l}
                  onClick={() => setLevel(l)}
                  className={clsx(
                    "px-2 py-0.5 rounded text-xs transition-colors",
                    level === l
                      ? l === "ERROR" ? "bg-[#ff525222] text-[#ff5252]"
                        : l === "WARN" ? "bg-[#ffab4022] text-[#ffab40]"
                        : l === "DEBUG" ? "bg-[#4a556822] text-[#4a5568]"
                        : "bg-[#00d4ff22] text-[#00d4ff]"
                      : "text-[#4a5568] hover:text-[#8892a4]"
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <Badge variant="gray">{filtered.length} entries</Badge>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-[#0a0e1a]">
        {filtered.length > 0 ? (
          <>
            {filtered.map((log) => (
              <LogLine key={log.timestamp + log.message} log={log} />
            ))}
            {live && (
              <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs text-[#4a5568]">
                <span className="w-1.5 h-1.5 bg-[#00e676] rounded-full animate-pulse-dot" />
                Streaming live…
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-32 text-sm text-[#4a5568] font-mono">
            No log entries match your filters
          </div>
        )}
      </div>
    </div>
  );
}

/** Moved out of the main dashboard app's `frontend/src/pages/Analytics.tsx`
 * (now a canister-listing page there instead, mirroring `Database.tsx` -
 * see that file's own header comment) per the user's own instruction
 * ("move the Analytics page to another react app in the packages"). A
 * standalone app, not embedded into any canister's own wasm (unlike
 * `packages/table-browser`'s relationship to `ic-sql`) - there's no real
 * usage-analytics/log-aggregation building block in this codebase to embed
 * it *into*; every tab below stays the same illustrative `lib/mock-data.ts`
 * sample data it always was, not a promise the numbers are real. The one
 * real-data widget the old page also carried (a "Cycles Balance" card,
 * fetching this project's actual cycles balance/burn rate) was dropped in
 * this move rather than ported - it needs a specific project's real job
 * id/principal, which this standalone app has no way to be given. */
export default function App() {
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "events", label: "Events" },
    { id: "funnels", label: "Funnels" },
    { id: "retention", label: "Retention" },
    { id: "logs", label: "Logs" },
  ];

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="px-6 pt-4 pb-0 border-b border-[#1e2d47]">
        <h1 className="text-lg font-semibold text-[#e2e8f0] mb-3 flex items-center gap-2">
          <BarChart2 size={18} className="text-[#00d4ff]" /> Analytics
        </h1>
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px",
                activeTab === tab.id
                  ? "text-[#00d4ff] border-[#00d4ff]"
                  : "text-[#8892a4] border-transparent hover:text-[#e2e8f0]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab === "overview" && <div className="h-full overflow-y-auto"><OverviewTab /></div>}
        {activeTab === "events" && <div className="h-full overflow-y-auto"><EventsTab /></div>}
        {activeTab === "funnels" && <div className="h-full overflow-y-auto"><FunnelsTab /></div>}
        {activeTab === "retention" && <div className="h-full overflow-y-auto"><RetentionTab /></div>}
        {activeTab === "logs" && <LogsTab />}
      </div>
      <ToastProvider />
    </div>
  );
}
