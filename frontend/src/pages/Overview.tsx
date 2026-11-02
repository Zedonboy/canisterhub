import { CopyLinkButton } from "@/components/CopyLinkButton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useNavigate, Link } from "react-router-dom";
import { ExternalLink, Database as DatabaseIcon, Sparkles, MoreVertical, Play, Square, Trash2, Rocket, Store, Bot, ListChecks, Settings as SettingsIcon, ChevronUp, ChevronDown, Search, Package, AppWindow, Globe } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { StatusDot } from "@/components/StatusDot";
import { CanisterID } from "@/components/CanisterID";
import { InstallCanisterDialog } from "@/components/InstallCanisterDialog";
import { toast } from "@/components/Toast";
import { formatCycles, formatBytes, MOCK_MARKETPLACE_ITEMS } from "@/lib/mock-data";
import type { ServiceStatus } from "@/lib/mock-data";
import type { ProjectContext } from "@/components/layout/AppShell";
import { removeProjectCanister, type Project, type ProjectState, type CanisterKind, type CanisterInfo } from "@/lib/backend";
import { getAllCanisterStats, getCanisterStatsDirect, type BusinessStats, type CanisterStats } from "@/lib/canisterStats";
import type { CanisterLink } from "@/lib/moduleConfig";
import { stopCanister, startCanister, deleteCanister } from "@/lib/canisterOps";
import type { CanisterType } from "@/lib/candid/canisterMetadata";
import { formatMarketplacePrice, listMarketplaceItems, purchasedMarketplaceItemIds, type MarketplaceItem } from "@/lib/marketplace";

function metadataTypeLabel(type: CanisterType | null | undefined): string | null {
  if (!type) return null;
  if ("Auth" in type) return "Auth";
  if ("Storage" in type) return "Storage";
  if ("Database" in type) return "Database";
  return "Custom";
}

/** Maps a project's real state to StatusDot's status vocabulary - same
 * mapping Dashboard.tsx uses, kept in sync intentionally (there's no
 * richer, real per-canister health signal yet, just this project's own
 * outcome). */
function jobStatus(state: ProjectState): "healthy" | "degraded" | "error" {
  if (state === "failed") return "error";
  if (state === "running" || state === "awaiting_answer") return "degraded";
  return "healthy";
}

/** Maps a canister's own real status (self-reported only when this
 * dashboard's identity happens to be a controller - see
 * `lib/canisterStats.ts`'s own doc comment) to StatusDot's vocabulary,
 * independent of the project's overall state. `status === null` (the
 * ordinary case on a mainnet job, where the browser's anonymous identity
 * controls nothing) reads as "degraded" - unknown, not necessarily
 * unhealthy - same as this card had no stats at all yet. A deliberately
 * `Stopped` canister (via the new Stop operation below) gets its own
 * distinct "stopped" dot rather than reading as an error. */
function canisterStatusDot(stats: CanisterStats | undefined): ServiceStatus {
  if (!stats) return "degraded";
  if (stats.error) return "error";
  if (stats.status === "running") return "healthy";
  if (stats.status === "stopping") return "degraded";
  if (stats.status === "stopped") return "stopped";
  return "degraded";
}

/** Business-level activity for one canister - what an operator actually
 * cares about, distinct from the infra numbers (memory/cycles) above it.
 * Renders nothing for a canister kind with no `business` stats at all
 * (only `connector`/`agent` currently have any - see
 * `lib/canisterStats.ts::businessStatsFor`). */
function BusinessStatsLine({ business }: { business: BusinessStats | undefined }) {
  if (!business) return null;
  if (business.messages_processed != null) {
    return <div>{business.messages_processed.toLocaleString()} messages processed</div>;
  }
  if (business.messages_in != null) {
    return (
      <>
        <div>{business.messages_in.toLocaleString()} in / {business.messages_out?.toLocaleString() ?? 0} out</div>
        <div>{(business.tokens_consumed ?? 0).toLocaleString()} tokens consumed</div>
      </>
    );
  }
  return null;
}

/** "each card should have option button to show operations that can be
 * performed on an icp canister example delete, update, update status"
 * (the user's own framing) - a real `⋮` menu calling the IC management
 * canister directly (`lib/canisterOps.ts`), same identity this dashboard
 * already uses for every other direct canister call. Start/Stop are
 * offered regardless of whether `status` is known (it's `null` on a job
 * whose local gateway can't answer `canister_status` at all - see
 * `lib/canisterStats.ts`'s own doc comment on that quirk - which says
 * nothing about whether the underlying write call itself would work), only
 * disabled once a matching status is genuinely confirmed. Delete needs an
 * explicit in-menu confirm step rather than `window.confirm` (a native
 * dialog would freeze this whole tab) - it's real and irreversible: the IC
 * itself won't undo it, and neither can this dashboard.
 *
 * The menu's top section lists every page the module itself declares via
 * `get_links` (`CanisterStats.links`). All of them open inside this
 * dashboard (`CanisterViewData`) at `?link=<index>`, so each page has its
 * own route; only an `Admin` (owner-only) page is also handed the user's
 * identity - a `Public` page is embedded as the public sees it. The card's
 * icon row can only fit the first of each kind, hence the full list here. */
function CanisterOpsMenu({
  job,
  name,
  info,
  status,
  links,
  onStatsChanged,
  onDeleted,
}: {
  job: Project;
  name: string;
  info: CanisterInfo;
  status: CanisterStats["status"] | undefined;
  links: CanisterLink[];
  onStatsChanged: () => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"start" | "stop" | "delete" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const runStart = async () => {
    setBusy("start");
    try {
      await startCanister(info.id, job.network);
      toast.success("Canister started", `${name} is running.`);
      onStatsChanged();
    } catch (e) {
      toast.error(`Couldn't start ${name}`, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const runStop = async () => {
    setBusy("stop");
    try {
      await stopCanister(info.id, job.network);
      toast.success("Canister stopped", `${name} is stopped.`);
      onStatsChanged();
    } catch (e) {
      toast.error(`Couldn't stop ${name}`, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const runDelete = async () => {
    setBusy("delete");
    try {
      await deleteCanister(info.id, job.network);
      await removeProjectCanister(job.id, name);
      toast.success("Canister deleted", `${name} was deleted and removed from this project.`);
      onDeleted();
    } catch (e) {
      toast.error(`Couldn't delete ${name}`, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setOpen(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-0.5 rounded text-[#4a5568] hover:text-[#e2e8f0] hover:bg-[#1a2236] transition-colors"
        title="Canister operations"
      >
        <MoreVertical size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-[#0f1629] border border-[#1e2d47] rounded-lg shadow-xl z-20 text-xs overflow-hidden">
          {!confirmDelete ? (
            <div className="py-1">
              {links.length > 0 && (
                <>
                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-[#4a5568]">Pages</div>
                  {links.map((link, index) => {
                    const internal = "Admin" in link.kind;
                    const Icon = internal ? AppWindow : Globe;
                    return (
                      <div key={`${index}:${link.label}`} className="flex items-center hover:bg-[#131929] transition-colors pr-1.5">
                        <Link
                          to={`/project/${job.id}/canister/${encodeURIComponent(info.id)}/view-data?link=${index}`}
                          onClick={() => setOpen(false)}
                          title={`${link.label} (${internal ? "owner page" : "public page"})`}
                          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left text-[#e2e8f0]"
                        >
                          <Icon size={11} className={internal ? "flex-shrink-0 text-[#8892a4]" : "flex-shrink-0 text-[#00d4ff]"} />
                          <span className="truncate flex-1">{link.label}</span>
                        </Link>
                        <CopyLinkButton url={link.url} label={link.label} />
                      </div>
                    );
                  })}
                  <div className="border-t border-[#1e2d47] my-1" />
                </>
              )}
              <button
                onClick={runStart}
                disabled={busy !== null || status === "running"}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#e2e8f0] hover:bg-[#131929] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play size={11} /> {busy === "start" ? "Starting…" : "Start"}
              </button>
              <button
                onClick={runStop}
                disabled={busy !== null || status === "stopped"}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#e2e8f0] hover:bg-[#131929] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Square size={11} /> {busy === "stop" ? "Stopping…" : "Stop"}
              </button>
              <div className="border-t border-[#1e2d47] my-1" />
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ff5252] hover:bg-[#ff525211] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 size={11} /> Delete
              </button>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              <p className="text-[#e2e8f0]">
                Delete <span className="font-medium">{name}</span>? This can't be undone.
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy !== null}
                  className="flex-1 px-2 py-1 rounded bg-[#1a2236] text-[#8892a4] hover:text-[#e2e8f0] transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={runDelete}
                  disabled={busy !== null}
                  className="flex-1 px-2 py-1 rounded bg-[#ff5252] text-white hover:bg-[#ff3838] transition-colors disabled:opacity-40"
                >
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InstalledCanisters({ job, refetch }: { job: Project; refetch: () => void }) {
  const canisters = Object.entries(job.canisters);
  const [stats, setStats] = useState<Record<string, CanisterStats> | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const loadStats = useCallback(() => {
    if (Object.keys(job.canisters).length === 0) return;
    getAllCanisterStats(job.canisters, job.network)
      .then((s) => setStats(s))
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.network, canisters.length]);

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, canisters.length]);

  /** Re-reads just one canister's own stats after a Start/Stop op on it,
   * rather than re-fetching every card on the page for a one-canister
   * change. */
  const reloadOne = useCallback(
    (name: string, info: CanisterInfo) => {
      getCanisterStatsDirect(name, info.id, info.kind, job.network)
        .then((s) => setStats((prev) => ({ ...(prev ?? {}), [name]: s })))
        .catch(() => {});
    },
    [job.network]
  );

  if (canisters.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider">
          Installed — {canisters.length} canister{canisters.length !== 1 ? "s" : ""}
        </h2>
        <div className="flex items-center gap-2">
          {statsError && <span className="text-[10px] text-[#ff5252]">Live stats unavailable: {statsError}</span>}
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand" : "Collapse"}
            className="p-2 rounded-lg border border-[#1e2d47] text-[#8892a4] hover:text-[#e2e8f0] hover:border-[#00d4ff44] hover:bg-[#1a2236] transition-colors"
          >
            {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
        </div>
      </div>
      {!collapsed && (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {canisters.map(([name, info]) => {
          const s = stats?.[name];
          const metadataType = metadataTypeLabel(s?.canister_type);
          const adminLink = s?.links.find((link) => "Admin" in link.kind);
          const publicLinks = s?.links.filter((link) => "Public" in link.kind) ?? [];
          return (
            <div key={name} className="flex flex-col gap-2 p-3 rounded-lg bg-[#0f1629] border border-[#1e2d47]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#e2e8f0] truncate">{name}</span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <StatusDot status={stats ? canisterStatusDot(s) : jobStatus(job.state)} />
                  <CanisterOpsMenu
                    job={job}
                    name={name}
                    info={info}
                    status={s?.status}
                    links={s?.links ?? []}
                    onStatsChanged={() => reloadOne(name, info)}
                    onDeleted={refetch}
                  />
                </div>
              </div>
              {(metadataType || s?.version) && (
                <span className="text-[10px] text-[#4a5568] uppercase tracking-wide">
                  {metadataType}
                  {metadataType && s?.version && " · "}
                  {s?.version && <span className="normal-case font-mono">v{s.version}</span>}
                </span>
              )}
              <CanisterID id={info.id} className="text-[10px]" />
              {!s?.error && (
                <div className="text-[10px] text-[#4a5568] space-y-0.5">
                  <div className="flex items-center gap-3">
                    <span>Memory: {s ? (s.memory_size != null ? formatBytes(s.memory_size) : "Unavailable") : "Loading…"}</span>
                    <span>Cycles: {s ? (s.cycles != null ? formatCycles(s.cycles) : "Unavailable") : "Loading…"}</span>
                  </div>
                  <BusinessStatsLine business={s?.business} />
                </div>
              )}
              {s?.error && <div className="text-[10px] text-[#ff5252] truncate" title={s.error}>{s.error}</div>}
              {/* Icon-only, single row, never wraps - these are quick
                  actions on an already-dense card, not a place for
                  multi-line labels. `View data` comes from
                  `canister-hub-sdk`'s `ic::config` surface
                  (`moduleLinksFor` in `lib/canisterStats.ts`) reporting an
                  Admin link - it's an iframe'd internal subpage, not
                  an external link, so a canister's own admin UI (e.g.
                  `ic-sql`'s embedded table-browser) stays inside this
                  dashboard. */}
              <div className="flex items-center gap-1 mt-auto pt-0.5">
                {adminLink && (
                  <Link
                    to={`/project/${job.id}/canister/${encodeURIComponent(info.id)}/view-data`}
                    title="View data"
                    className="p-1 rounded text-[#8892a4] hover:bg-[#1a2236] hover:text-[#00d4ff] transition-colors"
                  >
                    <DatabaseIcon size={12} />
                  </Link>
                )}
                {s?.has_config && (
                  <Link
                    to={`/project/${job.id}/canister/${encodeURIComponent(info.id)}/settings`}
                    title="Settings"
                    className="p-1 rounded text-[#8892a4] hover:bg-[#1a2236] hover:text-[#00d4ff] transition-colors"
                  >
                    <SettingsIcon size={12} />
                  </Link>
                )}
                {publicLinks.map((link) => (
                  <Link
                    key={`${link.label}:${link.url}`}
                    to={`/project/${job.id}/canister/${encodeURIComponent(info.id)}/view-data?link=${s!.links.indexOf(link)}`}
                    title={link.label}
                    className="p-1 rounded text-[#00d4ff] hover:bg-[#1a2236] transition-colors"
                  >
                    <Globe size={12} />
                  </Link>
                ))}
                {publicLinks.length === 0 && info.kind === "static" && s?.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" title="Open" className="p-1 rounded text-[#00d4ff] hover:bg-[#1a2236] transition-colors">
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

/** Real marketplace catalog (`list_marketplace_items`, the same real
 * `backend` catalog `InstallCanisterDialog`'s own search dropdown reads),
 * browsable and installable right on the Overview page instead of only
 * behind the "Create & Deploy a Canister" dialog - searching here filters
 * by title/description, same as that dialog's own search box. Picking an
 * item runs the exact same real deploy flow (`lib/deploy.ts`:
 * download/decrypt wasm, create canister, install code, set controllers)
 * and then hands off to Orchestrate with the new canister's id seeded into
 * the input, so a follow-up AI request already knows which canister it's
 * about - mirrors `InstallCanisterDialog::install` exactly, just rendered
 * inline instead of inside a modal. */
function MarketplaceSection({ job }: { job: Project }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketplaceItem[] | null>(null);
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listMarketplaceItems()
      .then(async (marketplaceItems) => {
        setItems(marketplaceItems);
        setPurchasedIds(await purchasedMarketplaceItemIds(marketplaceItems));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Nothing's been published to this `backend` yet - fall back to sample
  // listings so the Featured layout previews with something on it instead
  // of an empty state (see `MOCK_MARKETPLACE_ITEMS`'s own doc comment).
  const usingMock = items !== null && items.length === 0;
  const sourceItems = usingMock ? MOCK_MARKETPLACE_ITEMS : items;

  const filtered = useMemo(() => {
    const all = sourceItems ?? [];
    const q = query.toLowerCase().trim();
    if (!q) return all;
    return all.filter((item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q));
  }, [sourceItems, query]);

  // No search in progress: show a "Featured" shortlist (most downloaded
  // first) rather than the whole catalog - once searching, show every
  // match instead, not just the featured subset.
  const displayed = useMemo(() => {
    if (query.trim()) return filtered;
    return [...filtered].sort((a, b) => Number(b.downloads - a.downloads)).slice(0, 6);
  }, [filtered, query]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider">Marketplace</h2>
        {loadError && <span className="text-[10px] text-[#ff5252]">Couldn't load the marketplace: {loadError}</span>}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 mb-5 max-w-md mx-auto bg-[#0a0e1a] border border-[#1e2d47] rounded-lg focus-within:border-[#00d4ff55] transition-colors">
        <Search size={14} className="text-[#4a5568] flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the marketplace for a canister to install…"
          className="flex-1 bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none"
        />
      </div>

      {!loadError && items === null && <p className="text-xs text-[#4a5568] text-center">Loading marketplace…</p>}

      {items !== null && (
        displayed.length > 0 ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              {!query.trim() && (
                <h3 className="text-[11px] font-medium text-[#4a5568] uppercase tracking-wider">Featured</h3>
              )}
              {usingMock && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#c084fc33] bg-[#c084fc0d] text-[#c084fc]">
                  Sample listings - nothing's published yet
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayed.map((item) => {
                const idText = item.id.toString();
                const gated = item.encrypted_key !== undefined;
                const purchased = purchasedIds.has(idText);
                return (
                  <button
                    key={idText}
                    onClick={() => navigate(`/project/${job.id}/overview/product/${idText}`)}
                    className="text-left p-4 rounded-xl border border-[#1e2d47] bg-[#0d1526] hover:border-[#00d4ff44] hover:-translate-y-0.5 transition-all duration-150"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="w-10 h-10 rounded-lg bg-[#1a2236] border border-[#1e2d47] flex items-center justify-center flex-shrink-0">
                        <Package size={17} className="text-[#8892a4]" />
                      </div>
                      {gated && item.price != null && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${purchased ? "border-[#00d4ff44] bg-[#00d4ff12] text-[#00d4ff]" : "border-[#ffab4044] bg-[#ffab4022] text-[#ffab40]"}`}>
                          {purchased ? "Download" : formatMarketplacePrice(item.price)}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-semibold text-[#e2e8f0]">{item.title}</div>
                    <div className="text-xs text-[#8892a4] mt-1 leading-relaxed line-clamp-2">{item.description}</div>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-xs text-[#4a5568] text-center">
            {`No installable canister matches "${query}"`}
          </p>
        )
      )}
    </div>
  );
}

/** The full project-wide LLM context document (see `backend::Project::llm_context`'s
 * doc comment) - everything an LLM agent needs to understand this project
 * without inspecting anything else: the business requirement, every
 * canister's id, and each one's own `llm_context()` self-description.
 * Often tens of KB (each building block's own doc is substantial), so
 * collapsed by default rather than always rendered inline. */
function LlmContextCard({ context }: { context: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>LLM Context</CardTitle>
        <button onClick={() => setExpanded((v) => !v)} className="text-xs text-[#00d4ff] hover:underline">
          {expanded ? "Collapse" : `Expand (${(context.length / 1024).toFixed(1)} KB)`}
        </button>
      </CardHeader>
      {expanded && (
        <CardContent>
          <pre className="text-xs text-[#8892a4] whitespace-pre-wrap max-h-[32rem] overflow-y-auto font-mono">{context}</pre>
        </CardContent>
      )}
    </Card>
  );
}

/** Shown instead of the canister grid while a project has none yet - "the
 * Overview Page looks empty... add any element, or Empty State UI" (the
 * user's own framing). A brand-new project is just a `backend` record with
 * nothing installed into it - not "still building" (there's no job driving
 * it any more, see `Overview`'s own doc comment), so this reads as an
 * invitation to act, not a loading state. */
function WelcomeEmptyState({ onInstall, projectId }: { onInstall: () => void; projectId: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center text-center px-6 py-14 rounded-xl border border-dashed border-[#1e2d47] bg-[#0d1526]">
      <div className="relative mb-5">
        <div className="absolute inset-0 blur-2xl bg-[#00d4ff22] rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center">
          <Rocket size={24} className="text-[#00d4ff]" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">This project is empty so far</h3>
      <p className="text-sm text-[#4a5568] max-w-md mb-6">
        Nothing's deployed into it yet. Install a canister from the marketplace, or describe what you want
        and let Secretary build it for you.
      </p>
      <div className="flex items-center gap-2.5 mb-8">
        <Button variant="primary" size="sm" className="gap-1.5" onClick={onInstall}>
          <Store size={14} /> Browse the Marketplace
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/project/${projectId}/orchestrate`)}>
          <Bot size={14} /> Ask Secretary
        </Button>
      </div>
      <div className="w-full max-w-md text-left">
        <GettingStartedCard />
      </div>
    </div>
  );
}

/** Only ever shown as part of `WelcomeEmptyState` (a project with nothing
 * deployed yet) - not a general fallback for "nothing else to show" once
 * canisters exist. */
function GettingStartedCard() {
  const steps = [
    { icon: Store, text: "Install a real canister from the marketplace with “Create & Deploy a Canister.”" },
    { icon: Bot, text: "Or describe what you want to build in Secretary and let the AI assemble it." },
    { icon: ListChecks, text: "Once something's deployed, manage its cycles, stats, and lifecycle right from its card below." },
  ];
  return (
    <Card>
      <CardHeader><CardTitle>Getting started</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {steps.map(({ icon: Icon, text }, i) => (
          <div key={i} className="flex items-start gap-3 text-sm text-[#8892a4]">
            <div className="w-6 h-6 rounded-md bg-[#1a2236] border border-[#1e2d47] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Icon size={12} className="text-[#00d4ff]" />
            </div>
            <span>{text}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const [showInstallDialog, setShowInstallDialog] = useState(false);

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const canisters = Object.entries(job.canisters);
  // A project is just a `backend` record now, not a running job (see the
  // `decouple-orchestrator-api` project notes) - "running" is its default,
  // permanent resting state for most projects' whole lifetime, so showing
  // it as a status would read as something actively happening when nothing
  // is. Only the two states that genuinely need your attention get a badge.
  const needsAttention = job.state === "awaiting_answer" || job.state === "failed";

  return (
    <div className="p-4 sm:p-6 space-y-8 animate-fade-in">
      <div>
        <p className="text-xs text-[#00d4ff] font-medium tracking-wide mb-1">Welcome back</p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[#e2e8f0]">{job.project_name ?? job.id}</h2>
            <p className="text-sm text-[#4a5568] mt-1">{job.request}</p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {needsAttention && <Badge variant={job.state === "failed" ? "red" : "amber"}>{job.state === "failed" ? "Failed" : "Awaiting your answer"}</Badge>}
            {/* Marketplace install dialog disabled for production launch (no funds yet) - see TODO.md
            <Button variant="primary" size="sm" className="gap-1.5" onClick={() => setShowInstallDialog(true)}>
              <Sparkles size={14} /> Create &amp; Deploy a Canister
            </Button>
            */}
          </div>
        </div>
      </div>

      {canisters.length === 0 ? (
        <WelcomeEmptyState onInstall={() => setShowInstallDialog(true)} projectId={job.id} />
      ) : (
        <InstalledCanisters job={job} refetch={refetch} />
      )}

      <MarketplaceSection job={job} />

      {(job.pending_question || job.error || job.final_message || job.llm_context) && (
        <div className="space-y-4">
          {job.pending_question && (
            <Card>
              <CardHeader><CardTitle>Awaiting your answer</CardTitle></CardHeader>
              <CardContent className="text-sm text-[#e2e8f0]">{job.pending_question}</CardContent>
            </Card>
          )}
          {job.error && (
            <Card>
              <CardHeader><CardTitle>Error</CardTitle></CardHeader>
              <CardContent className="text-sm text-[#ff5252]">{job.error}</CardContent>
            </Card>
          )}
          {job.final_message && (
            <Card>
              <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
              <CardContent className="text-sm text-[#8892a4] whitespace-pre-wrap">{job.final_message}</CardContent>
            </Card>
          )}
          {job.llm_context && <LlmContextCard context={job.llm_context} />}
        </div>
      )}

      <InstallCanisterDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        jobId={job.id}
        network={job.network}
        onDeployed={refetch}
      />
    </div>
  );
}
