import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { ArrowLeft, Workflow, RefreshCw, Info, Plug, Bot, Database as DatabaseIcon, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogHeader, DialogContent } from "@/components/ui/Dialog";
import { toast } from "@/components/Toast";
import type { ProjectContext } from "@/components/layout/AppShell";
import {
  loadAgentMap, wireConnectorToAgent, unwireConnectorFromAgent, wireAgentToDatabase, unwireAgentFromDatabase,
  getNodeLlmContext, type AgentMapData, type MapNode, type MapNodeKind, type MapEdge,
} from "@/lib/agentMap";
import { clsx } from "clsx";

/** "a drag and drop interface, that shows Agent Map... like a Visual
 * Scripting Editor Tool similar to Unity Blueprint Tool" (the user's own
 * framing) - every node is a real canister on this project, every edge is
 * a real `Config` field read live off the canister that owns it, and every
 * drag-to-connect/click-to-disconnect gesture below is a real
 * `update_config` call (see `lib/agentMap.ts`), not a locally-drawn line
 * that only looks wired.
 *
 * Only two edge kinds actually exist on the real canisters:
 * connector→agent (`connector.agent_canister` + `agent.connector_principal`
 * together) and agent→database (`agent.ic_sql_canister_id`, `ic-sql` only -
 * `ic-kv`/`vector_db` have no equivalent field to point at). Storage
 * canisters are drawn for visibility, since a project's own asset bucket is
 * as real a part of its architecture as anything else here, but their
 * input port is deliberately inert: the real `agent` canister has no
 * config field to wire to one, and the certified-assets interface has no
 * `llm_context` method either - inventing either would mean this map
 * accepting a drag that quietly does nothing. Node positions are a
 * per-viewer convenience only (`localStorage`, keyed by project) - not
 * real project state, so they're never round-tripped through any canister.
 */

const NODE_WIDTH = 208;
const NODE_HEIGHT = 60;
const COLUMN_GAP = 280;
const ROW_GAP = 96;
const CANVAS_MARGIN = 60;
const SNAP_DISTANCE = 42;

interface Pos {
  x: number;
  y: number;
}

function nodeKey(n: MapNode): string {
  return `${n.kind}:${n.id}`;
}

const NODE_META: Record<MapNodeKind, { icon: typeof Plug; color: string; label: string }> = {
  connector: { icon: Plug, color: "#00d4ff", label: "Connector" },
  agent: { icon: Bot, color: "#c084fc", label: "Agent" },
  database: { icon: DatabaseIcon, color: "#00e676", label: "Database" },
  storage: { icon: HardDrive, color: "#ffab40", label: "Storage" },
};

function outputPort(pos: Pos): Pos {
  return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT / 2 };
}
function inputPort(pos: Pos): Pos {
  return { x: pos.x, y: pos.y + NODE_HEIGHT / 2 };
}

function layoutStorageKey(projectId: string): string {
  return `agent-map-layout:${projectId}`;
}

function loadSavedLayout(projectId: string): Record<string, Pos> {
  try {
    const raw = localStorage.getItem(layoutStorageKey(projectId));
    return raw ? (JSON.parse(raw) as Record<string, Pos>) : {};
  } catch {
    return {};
  }
}

function saveLayout(projectId: string, layout: Record<string, Pos>) {
  try {
    localStorage.setItem(layoutStorageKey(projectId), JSON.stringify(layout));
  } catch {
    // Best-effort per-viewer convenience only - never blocks a real wire.
  }
}

function defaultLayout(data: AgentMapData): Record<string, Pos> {
  const layout: Record<string, Pos> = {};
  const columns: MapNode[][] = [data.connectors, data.agents, [...data.databases, ...data.storages]];
  columns.forEach((nodes, col) => {
    nodes.forEach((n, row) => {
      layout[nodeKey(n)] = { x: CANVAS_MARGIN + col * COLUMN_GAP, y: CANVAS_MARGIN + row * ROW_GAP };
    });
  });
  return layout;
}

/** A real edge can only ever start from a connector's or an agent's output
 * port - database/storage nodes have no output port at all, and dragging
 * from one simply isn't possible (see `NodeCard`'s own rendering). */
function candidateTargets(fromKind: MapNodeKind, data: AgentMapData): MapNode[] {
  if (fromKind === "connector") return data.agents;
  if (fromKind === "agent") return data.databases;
  return [];
}

function nearestCandidate(cursor: Pos, candidates: MapNode[], layout: Record<string, Pos>): MapNode | null {
  let best: MapNode | null = null;
  let bestDist = SNAP_DISTANCE;
  for (const n of candidates) {
    const pos = layout[nodeKey(n)];
    if (!pos) continue;
    const port = inputPort(pos);
    const dist = Math.hypot(cursor.x - port.x, cursor.y - port.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  return best;
}

function LlmContextDialog({ node, network, onClose }: { node: MapNode | null; network: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return;
    setText(null);
    setError(null);
    getNodeLlmContext(node, network)
      .then(setText)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [node, network]);

  if (!node) return null;

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader title={`${node.name} · llm_context`} onClose={onClose} />
      <DialogContent className="max-h-[70vh] overflow-y-auto">
        {error && <p className="text-sm text-[#ff5252]">Couldn't load llm_context: {error}</p>}
        {!error && text === null && <p className="text-sm text-[#4a5568]">Loading…</p>}
        {text !== null && <pre className="text-[11px] text-[#8892a4] whitespace-pre-wrap font-mono leading-relaxed">{text}</pre>}
      </DialogContent>
    </Dialog>
  );
}

function NodeCard({
  node,
  pos,
  hasInput,
  hasOutput,
  inputDisabled,
  inputHighlighted,
  busy,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerUp,
  onOutputPointerDown,
  onOutputPointerMove,
  onOutputPointerUp,
  onInfo,
}: {
  node: MapNode;
  pos: Pos;
  hasInput: boolean;
  hasOutput: boolean;
  inputDisabled: boolean;
  inputHighlighted: boolean;
  busy: boolean;
  onDragPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDragPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDragPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onOutputPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onOutputPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onOutputPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onInfo: () => void;
}) {
  const meta = NODE_META[node.kind];
  const Icon = meta.icon;

  return (
    <div style={{ position: "absolute", left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }} className="select-none">
      <div className={clsx("h-full rounded-lg border bg-[#0f1629] shadow-lg transition-colors", node.kind === "storage" ? "border-[#1e2d47] opacity-70" : "border-[#1e2d47] hover:border-[#00d4ff44]")}>
        <div
          className={clsx("flex items-center gap-2 px-3 h-full", busy ? "cursor-not-allowed" : "cursor-move")}
          onPointerDown={busy ? undefined : onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
        >
          <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${meta.color}1a`, border: `1px solid ${meta.color}33` }}>
            <Icon size={13} style={{ color: meta.color }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-[#e2e8f0] truncate">{node.name}</div>
            <div className="text-[10px] text-[#4a5568] font-mono truncate">{node.id.slice(0, 10)}…</div>
          </div>
          {node.kind !== "storage" && (
            <button onPointerDown={(e) => e.stopPropagation()} onClick={onInfo} className="p-1 text-[#4a5568] hover:text-[#00d4ff] transition-colors flex-shrink-0" title="View this canister's real llm_context">
              <Info size={12} />
            </button>
          )}
        </div>
      </div>

      {hasInput && (
        <div
          className={clsx(
            "absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 transition-colors",
            inputDisabled ? "bg-[#0a0e1a] border-[#2a3550] cursor-not-allowed" : inputHighlighted ? "bg-[#00d4ff] border-[#00d4ff]" : "bg-[#0a0e1a] border-[#4a5568]"
          )}
          style={{ left: -7 }}
          title={inputDisabled ? "Not wireable - the real agent canister has no config field for this" : "Drop a connection here"}
        />
      )}
      {hasOutput && (
        <div
          onPointerDown={busy ? undefined : onOutputPointerDown}
          onPointerMove={onOutputPointerMove}
          onPointerUp={onOutputPointerUp}
          className={clsx("absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 bg-[#0a0e1a] border-[#00d4ff] transition-colors", busy ? "cursor-not-allowed opacity-50" : "cursor-crosshair hover:bg-[#00d4ff]")}
          style={{ right: -7 }}
          title="Drag to connect"
        />
      )}
    </div>
  );
}

export default function AgentMapPage() {
  const { job, loadError: jobLoadError } = useOutletContext<ProjectContext>();
  const [data, setData] = useState<AgentMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<Record<string, Pos>>({});
  const [busy, setBusy] = useState(false);
  const [infoNode, setInfoNode] = useState<MapNode | null>(null);
  const [dragNodeKey, setDragNodeKey] = useState<string | null>(null);
  const dragOffset = useRef<Pos>({ x: 0, y: 0 });
  const [connecting, setConnecting] = useState<{ from: MapNode; cursor: Pos } | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const load = () => {
    if (!job) return;
    setLoading(true);
    setLoadError(null);
    loadAgentMap(job)
      .then((d) => {
        setData(d);
        setLayout({ ...defaultLayout(d), ...loadSavedLayout(job.id) });
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (job) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const allNodes: MapNode[] = data ? [...data.connectors, ...data.agents, ...data.databases, ...data.storages] : [];

  const canvasSize = useMemo(() => {
    let maxX = 900;
    let maxY = 500;
    for (const pos of Object.values(layout)) {
      maxX = Math.max(maxX, pos.x + NODE_WIDTH + CANVAS_MARGIN);
      maxY = Math.max(maxY, pos.y + NODE_HEIGHT + CANVAS_MARGIN);
    }
    return { width: maxX, height: maxY };
  }, [layout]);

  const toCanvasPoint = (e: ReactPointerEvent): Pos => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left + canvas.scrollLeft, y: e.clientY - rect.top + canvas.scrollTop };
  };

  const startNodeDrag = (e: ReactPointerEvent<HTMLDivElement>, node: MapNode) => {
    const key = nodeKey(node);
    const pos = layout[key];
    if (!pos) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = toCanvasPoint(e);
    dragOffset.current = { x: point.x - pos.x, y: point.y - pos.y };
    setDragNodeKey(key);
  };

  const onNodeDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragNodeKey) return;
    const point = toCanvasPoint(e);
    setLayout((prev) => ({ ...prev, [dragNodeKey]: { x: Math.max(0, point.x - dragOffset.current.x), y: Math.max(0, point.y - dragOffset.current.y) } }));
  };

  const endNodeDrag = () => {
    if (!dragNodeKey) return;
    setDragNodeKey(null);
    setLayout((prev) => {
      if (job) saveLayout(job.id, prev);
      return prev;
    });
  };

  const startConnect = (e: ReactPointerEvent<HTMLDivElement>, node: MapNode) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setConnecting({ from: node, cursor: toCanvasPoint(e) });
  };

  const onConnectMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!connecting || !data) return;
    const cursor = toCanvasPoint(e);
    const nearest = nearestCandidate(cursor, candidateTargets(connecting.from.kind, data), layout);
    setHoveredKey(nearest ? nodeKey(nearest) : null);
    setConnecting({ ...connecting, cursor });
  };

  const endConnect = async () => {
    if (!connecting || !data || !job) {
      setConnecting(null);
      return;
    }
    const target = hoveredKey ? allNodes.find((n) => nodeKey(n) === hoveredKey) ?? null : null;
    const from = connecting.from;
    setConnecting(null);
    setHoveredKey(null);
    if (!target) return;

    setBusy(true);
    try {
      if (from.kind === "connector" && target.kind === "agent") {
        await wireConnectorToAgent(from, target, job.network);
        toast.success("Wired", `${from.name} now forwards to ${target.name}.`);
      } else if (from.kind === "agent" && target.kind === "database") {
        await wireAgentToDatabase(from, target, job.network);
        toast.success("Wired", `${from.name} now queries ${target.name}.`);
      }
      load();
    } catch (e) {
      toast.error("Couldn't wire these up", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeEdge = async (edge: MapEdge) => {
    if (!job || busy) return;
    setBusy(true);
    try {
      if (edge.kind === "connector-agent") {
        await unwireConnectorFromAgent(edge.from, edge.to, job.network);
      } else {
        await unwireAgentFromDatabase(edge.from, job.network);
      }
      toast.success("Disconnected", `${edge.from.name} → ${edge.to.name} removed.`);
      load();
    } catch (e) {
      toast.error("Couldn't remove this connection", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (jobLoadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {jobLoadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const totalNodes = data ? data.connectors.length + data.agents.length + data.databases.length + data.storages.length : 0;

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2d47] flex-shrink-0">
        <div>
          <Link to={`/project/${job.id}/agents`} className="inline-flex items-center gap-1 text-xs text-[#4a5568] hover:text-[#e2e8f0] transition-colors mb-1.5">
            <ArrowLeft size={12} /> Back to Agents
          </Link>
          <h1 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <Workflow size={18} className="text-[#00d4ff]" /> Agent Map
          </h1>
          <p className="text-xs text-[#4a5568] mt-1">Drag an output port onto a compatible input port to wire two real canisters together.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {loadError && <div className="p-6 text-sm text-[#ff5252]">Couldn't load the map: {loadError}</div>}

      {!loadError && data && totalNodes === 0 && (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-sm text-[#4a5568] text-center max-w-sm">
            No connector, agent, or database canisters yet - deploy some from the Agents or Database pages, then come back to wire them together.
          </p>
        </div>
      )}

      {!loadError && data && totalNodes > 0 && (
        <div ref={canvasRef} className="flex-1 relative overflow-auto" style={{ backgroundImage: "radial-gradient(#1a2236 1px, transparent 1px)", backgroundSize: "22px 22px" }}>
          <div style={{ position: "relative", width: canvasSize.width, height: canvasSize.height }}>
            <svg className="absolute inset-0" style={{ width: canvasSize.width, height: canvasSize.height, pointerEvents: "none" }}>
              {data.edges.map((edge) => {
                const fromPos = layout[nodeKey(edge.from)];
                const toPos = layout[nodeKey(edge.to)];
                if (!fromPos || !toPos) return null;
                const p1 = outputPort(fromPos);
                const p2 = inputPort(toPos);
                const midX = (p1.x + p2.x) / 2;
                const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                return (
                  <g key={`${nodeKey(edge.from)}->${nodeKey(edge.to)}`}>
                    <path d={`M ${p1.x},${p1.y} C ${midX},${p1.y} ${midX},${p2.y} ${p2.x},${p2.y}`} stroke="#00d4ff99" strokeWidth={2} fill="none" />
                    <g style={{ pointerEvents: "auto", cursor: busy ? "not-allowed" : "pointer" }} onClick={() => removeEdge(edge)}>
                      <circle cx={mid.x} cy={mid.y} r={9} fill="#0f1629" stroke="#ff5252" strokeWidth={1.5} />
                      <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fontSize={11} fill="#ff5252">
                        ×
                      </text>
                    </g>
                  </g>
                );
              })}
              {connecting &&
                (() => {
                  const fromPos = layout[nodeKey(connecting.from)];
                  if (!fromPos) return null;
                  const p1 = outputPort(fromPos);
                  const midX = (p1.x + connecting.cursor.x) / 2;
                  return <path d={`M ${p1.x},${p1.y} C ${midX},${p1.y} ${midX},${connecting.cursor.y} ${connecting.cursor.x},${connecting.cursor.y}`} stroke="#00d4ff" strokeWidth={2} strokeDasharray="5 4" fill="none" />;
                })()}
            </svg>

            {allNodes.map((node) => {
              const key = nodeKey(node);
              const pos = layout[key];
              if (!pos) return null;
              return (
                <NodeCard
                  key={key}
                  node={node}
                  pos={pos}
                  hasInput={node.kind !== "connector"}
                  hasOutput={node.kind === "connector" || node.kind === "agent"}
                  inputDisabled={node.kind === "storage"}
                  inputHighlighted={hoveredKey === key}
                  busy={busy}
                  onDragPointerDown={(e) => startNodeDrag(e, node)}
                  onDragPointerMove={onNodeDragMove}
                  onDragPointerUp={endNodeDrag}
                  onOutputPointerDown={(e) => startConnect(e, node)}
                  onOutputPointerMove={onConnectMove}
                  onOutputPointerUp={endConnect}
                  onInfo={() => setInfoNode(node)}
                />
              );
            })}
          </div>

          <div className="fixed bottom-4 right-4 bg-[#0f1629]/95 border border-[#1e2d47] rounded-lg px-3 py-2.5 text-[10px] text-[#4a5568] space-y-1 max-w-[220px]">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-[#00d4ff]" /> Drag an output port to wire it up
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[#ff5252] font-mono">×</span> Click a connection to remove it
            </div>
            <div className="text-[#ffab40]">Storage nodes are shown for visibility only - the real agent canister has no config field to wire to one yet</div>
          </div>
        </div>
      )}

      <LlmContextDialog node={infoNode} network={job.network} onClose={() => setInfoNode(null)} />
    </div>
  );
}
