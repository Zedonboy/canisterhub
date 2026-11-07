// Unified live log viewer for a project - polls the IC management
// canister's `fetch_canister_logs` (`lib/canisterLogs.ts`) for the
// project's canisters and tails the merged stream in one scrollback
// window. The selector picks a single canister or `All`, in which case
// every canister is polled in parallel each interval and its lines are
// interleaved by timestamp. Nothing here is persisted or filtered
// client-side beyond a display cap - the window shows what the IC
// currently holds in each canister's own debug buffer. The Reload
// button invokes the same poll on demand (even while paused).

import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Pause, Play, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import type { ProjectContext } from "@/components/layout/AppShell";
import type { CanisterInfo } from "@/lib/backend";
import { fetchCanisterLogTail } from "@/lib/canisterLogs";

const ALL = "all";
const POLL_MS = 4_000;
/** Display cap - the scrollback never grows past this many lines; the IC
 * itself caps a canister's buffer far lower, this only bounds the merged
 * multi-canister view over long sessions. */
const MAX_LINES = 1_000;

interface LogLine {
  key: string;
  canisterName: string;
  idx: bigint;
  /** Milliseconds since the Unix epoch (`timestamp` ns / 1e6). */
  ts: number;
  text: string;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-3)}` : id;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Anything the canister printed can claim to be any level, so this is
 * substring sniffing for coloring only, never a parsed field. */
function levelColor(text: string): string {
  const upper = text.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("PANIC") || upper.includes("TRAP")) return "#ff5252";
  if (upper.includes("WARN")) return "#f6c85f";
  if (upper.includes("DEBUG") || upper.includes("TRACE")) return "#8892a4";
  return "#c7d0e0";
}

export default function Logs() {
  const { job } = useOutletContext<ProjectContext>();

  const canisters = useMemo(
    () => (job ? (Object.entries(job.canisters) as Array<[string, CanisterInfo]>).sort(([a], [b]) => a.localeCompare(b)) : []),
    [job]
  );
  const network = job?.network ?? "local";

  const [selection, setSelection] = useState<string>(ALL);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Latest poll, exposed to the Reload button - assigned before the
   * paused early-return so a paused view still accepts an explicit
   * refresh. */
  const pollRef = useRef<() => Promise<void>>(async () => {});
  /** Dedupe across polls - `(canister, idx)` is a stable identity. */
  const seen = useRef(new Set<string>());

  // A different canister (or project) starts a fresh stream.
  useEffect(() => {
    setLines([]);
    seen.current = new Set();
    setErrors({});
  }, [selection, job?.id]);

  useEffect(() => {
    if (!job) return;

    const targets =
      selection === ALL ? canisters : canisters.filter(([, info]) => info.id === selection);

    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        targets.map(
          async ([name, info]): Promise<
            | { name: string; records: Awaited<ReturnType<typeof fetchCanisterLogTail>> }
            | { name: string; records: null; error: string }
          > => {
            try {
              return { name, records: await fetchCanisterLogTail(info.id, network) };
            } catch (e) {
              return { name, records: null, error: e instanceof Error ? e.message : String(e) };
            }
          }
        )
      );
      if (cancelled) return;

      const nextErrors: Record<string, string> = {};
      const fresh: LogLine[] = [];
      for (const result of results) {
        if (result.records === null) {
          nextErrors[result.name] = result.error;
          continue;
        }
        for (const record of result.records) {
          const key = `${result.name}#${record.idx}`;
          if (seen.current.has(key)) continue;
          seen.current.add(key);
          for (const [n, text] of record.text.split(/\r?\n/).entries()) {
            fresh.push({
              key: n === 0 ? key : `${key}.${n}`,
              canisterName: result.name,
              idx: record.idx,
              ts: Number(record.timestamp / 1_000_000n),
              text,
            });
          }
        }
      }
      if (fresh.length > 0) {
        setLines((prev) => [...prev, ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_LINES));
      }
      setErrors(nextErrors);
      setLastUpdated(new Date());
    };

    pollRef.current = poll;
    if (paused) return;

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job, canisters, selection, network, paused]);

  // Stick to the bottom while new lines arrive, unless the user scrolled
  // up to read something (then their position wins).
  const windowRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = windowRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!job) {
    return <div className="p-6"><p className="text-sm text-[#4a5568]">Loading project…</p></div>;
  }

  const failed = Object.entries(errors);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
          <ScrollText size={18} className="text-[#00d4ff]" /> Logs
        </h1>
        <p className="text-xs text-[#4a5568] mt-1">
          Live tail of each canister's own debug buffer via the IC's <code className="font-mono">fetch_canister_logs</code> API,
          polled every {POLL_MS / 1000}s.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selection}
          onChange={setSelection}
          className="w-64"
          options={[
            { value: ALL, label: `All canisters (${canisters.length})` },
            ...canisters.map(([name, info]) => ({ value: info.id, label: `${name} (${shortId(info.id)})` })),
          ]}
        />
        <Button variant="ghost" size="sm" onClick={() => setPaused((p) => !p)} className="gap-1.5">
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void pollRef.current().finally(() => setRefreshing(false));
          }}
          className="gap-1.5"
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          Reload
        </Button>
        <span className="text-[10px] text-[#4a5568]">
          {lines.length} line{lines.length === 1 ? "" : "s"}
          {lastUpdated && !paused && ` · updated ${lastUpdated.toLocaleTimeString()}`}
          {paused && " · paused"}
        </span>
      </div>

      {failed.length > 0 && (
        <p className="text-[10px] text-[#f6c85f]">
          {failed.map(([name, message]) => `${name}: ${message}`).join(" · ")}
          {" - "}log visibility is controllers-only by default; unreachable canisters fail the same way.
        </p>
      )}

      <div
        ref={windowRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[60vh] overflow-y-auto rounded-lg border border-[#1e2d47] bg-[#05070d] p-3 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-[#4a5568]">
            {canisters.length === 0
              ? "This project has no canisters yet."
              : "No log records yet - canisters emit these via debug_print; they appear here within a few seconds."}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="flex-shrink-0 text-[#4a5568]">{formatTime(line.ts)}</span>
              {selection === ALL && <span className="flex-shrink-0 text-[#00d4ff]">[{line.canisterName}]</span>}
              <span style={{ color: levelColor(line.text) }}>{line.text || " "}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
