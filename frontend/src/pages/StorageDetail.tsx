import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useParams, Link } from "react-router-dom";
import { ArrowLeft, HardDrive, RefreshCw, Files, FolderOpen, Gauge, ExternalLink, ChevronDown, ChevronRight as ChevronRightIcon, Search, Upload, Trash2, Copy, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CanisterID } from "@/components/CanisterID";
import { toast } from "@/components/Toast";
import { formatBytes, relativeTime } from "@/lib/mock-data";
import type { ProjectContext } from "@/components/layout/AppShell";
import {
  listStorageCanisters, listAssets, uploadFile, deleteAsset, latestModified, assetUrl, groupIntoFolders, computeUsage,
  type AssetFile,
} from "@/lib/assetStorage";
import { getCanisterStatsDirect, type CanisterStats } from "@/lib/canisterStats";

const TABS = [
  { id: "files", label: "Files", icon: Files },
  { id: "bucket", label: "Bucket", icon: FolderOpen },
  { id: "usage", label: "Usage Explorer", icon: Gauge },
] as const;
type TabId = (typeof TABS)[number]["id"];

function CopyAssetUrlButton({ url, compact = false }: { url: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("URL copied", url);
    } catch (error) {
      toast.error("Couldn't copy URL", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Absolute file URL copied" : "Copy absolute file URL"}
      aria-label={copied ? "Absolute file URL copied" : "Copy absolute file URL"}
      className="inline-flex items-center gap-1 text-xs text-[#8892a4] hover:text-[#00d4ff] transition-colors flex-shrink-0"
    >
      {copied ? <Check size={11} className="text-[#00e676]" /> : <Copy size={11} />}
      {!compact && (copied ? "Copied" : "Copy URL")}
    </button>
  );
}

/** Real, irreversible delete needs an explicit two-click confirm rather than
 * `window.confirm` (a native dialog would freeze this whole tab) - same
 * convention `Overview.tsx::CanisterOpsMenu`'s own Delete already uses. */
function FileDeleteButton({ fileKey, onDelete, busy }: { fileKey: string; onDelete: (key: string) => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-1 flex-shrink-0 text-[10px]">
        <span className="text-[#4a5568]">Delete?</span>
        <button
          onClick={() => {
            setConfirming(false);
            onDelete(fileKey);
          }}
          disabled={busy}
          className="px-1.5 py-0.5 rounded bg-[#ff525222] text-[#ff5252] hover:bg-[#ff525233] transition-colors disabled:opacity-50"
        >
          Yes
        </button>
        <button onClick={() => setConfirming(false)} disabled={busy} className="px-1.5 py-0.5 rounded text-[#8892a4] hover:bg-[#1a2236] transition-colors">
          No
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      disabled={busy}
      title="Delete this file"
      className="flex-shrink-0 text-[#4a5568] hover:text-[#ff5252] transition-colors disabled:opacity-50"
    >
      <Trash2 size={13} className={busy ? "animate-pulse" : ""} />
    </button>
  );
}

function FilesTab({
  files,
  canisterId,
  network,
  onUpload,
  onDelete,
  busyKey,
  uploading,
}: {
  files: AssetFile[];
  canisterId: string;
  network: string;
  onUpload: (file: File) => void;
  onDelete: (key: string) => void;
  busyKey: string | null;
  uploading: boolean;
}) {
  const [query, setQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return files;
    return files.filter((f) => f.key.toLowerCase().includes(q) || f.contentType.toLowerCase().includes(q));
  }, [files, query]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg max-w-sm flex-1">
          <Search size={14} className="text-[#4a5568] flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="flex-1 bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = "";
          }}
        />
        <Button variant="primary" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          <Upload size={13} className={uploading ? "animate-pulse" : ""} /> {uploading ? "Uploading…" : "Upload File"}
        </Button>
      </div>
      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-sm text-[#4a5568] p-4">{files.length === 0 ? "No files in this bucket yet." : "No file matches your search."}</p>
        ) : (
          filtered.map((f) => {
            const url = assetUrl(canisterId, network, f.key);
            return (
              <div key={f.key} className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[#e2e8f0] font-mono truncate">{f.key}</div>
                  <div className="text-[11px] text-[#4a5568] mt-0.5 flex items-center gap-2">
                    <span>{f.contentType}</span>
                    <span>·</span>
                    <span>{formatBytes(f.size)}</span>
                    <span>·</span>
                    <span>{relativeTime(f.modifiedAt)}</span>
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {f.encodings.map((e) => (
                    <Badge key={e} variant="gray">{e}</Badge>
                  ))}
                </div>
                <CopyAssetUrlButton url={url} />
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-[#00d4ff] hover:underline flex-shrink-0"
                >
                  Open <ExternalLink size={11} />
                </a>
                <FileDeleteButton fileKey={f.key} onDelete={onDelete} busy={busyKey === f.key} />
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}

function BucketTab({ files, canisterId, network }: { files: AssetFile[]; canisterId: string; network: string }) {
  const folders = useMemo(() => groupIntoFolders(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (folders.length === 0) {
    return <p className="text-sm text-[#4a5568]">No files in this bucket yet.</p>;
  }

  return (
    <Card className="overflow-hidden">
      {folders.map((folder) => {
        const open = expanded.has(folder.path);
        return (
          <div key={folder.path} className="border-b border-[#1e2d47] last:border-0">
            <button onClick={() => toggle(folder.path)} className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-[#131929] transition-colors text-left">
              {open ? <ChevronDown size={14} className="text-[#4a5568] flex-shrink-0" /> : <ChevronRightIcon size={14} className="text-[#4a5568] flex-shrink-0" />}
              <FolderOpen size={14} className="text-[#ffab40] flex-shrink-0" />
              <span className="text-sm text-[#e2e8f0] font-mono flex-1 min-w-0 truncate">{folder.path === "/" ? "/ (root)" : folder.path}</span>
              <span className="text-[11px] text-[#4a5568] flex-shrink-0">{folder.files.length} file{folder.files.length !== 1 ? "s" : ""} · {formatBytes(folder.totalSize)}</span>
            </button>
            {open && (
              <div className="bg-[#0a0e1a]">
                {folder.files.map((f) => (
                  <div key={f.key} className="flex items-center gap-3 pl-11 pr-4 py-2 border-t border-[#1e2d47]">
                    <span className="text-xs text-[#8892a4] font-mono truncate flex-1 min-w-0">{f.key.split("/").pop()}</span>
                    <span className="text-[10px] text-[#4a5568] flex-shrink-0">{formatBytes(f.size)}</span>
                    <CopyAssetUrlButton url={assetUrl(canisterId, network, f.key)} compact />
                    <a href={assetUrl(canisterId, network, f.key)} target="_blank" rel="noreferrer" className="text-[#00d4ff] hover:underline flex-shrink-0">
                      <ExternalLink size={11} />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function UsageExplorerTab({ files, lastUpdated, canisterStats }: { files: AssetFile[]; lastUpdated: string | null; canisterStats: CanisterStats | null }) {
  const usage = useMemo(() => computeUsage(files), [files]);
  const maxBytes = usage.byContentType[0]?.bytes ?? 1;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardContent className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xl font-semibold text-[#e2e8f0]">{usage.fileCount}</div>
              <div className="text-[11px] text-[#4a5568] mt-0.5">Files</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-[#e2e8f0]">{formatBytes(usage.totalBytes)}</div>
              <div className="text-[11px] text-[#4a5568] mt-0.5">Total size</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-[#e2e8f0]">{usage.byContentType.length}</div>
              <div className="text-[11px] text-[#4a5568] mt-0.5">Content types</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider">By content type</h3>
            {usage.byContentType.length === 0 && <p className="text-sm text-[#4a5568]">Nothing stored yet.</p>}
            {usage.byContentType.map((t) => (
              <div key={t.contentType} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#e2e8f0] font-mono">{t.contentType}</span>
                  <span className="text-[#4a5568]">{t.count} file{t.count !== 1 ? "s" : ""} · {formatBytes(t.bytes)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#1a2236] overflow-hidden">
                  <div className="h-full bg-[#00d4ff]" style={{ width: `${(t.bytes / maxBytes) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-2 text-xs">
            <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider mb-2">Canister resources</h3>
            {canisterStats === null && <p className="text-[#4a5568]">Loading…</p>}
            {canisterStats?.error && <p className="text-[#ff5252]">{canisterStats.error}</p>}
            {canisterStats && !canisterStats.error && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[#4a5568]">Cycles</span>
                  <span className="text-[#e2e8f0] font-mono">{canisterStats.cycles != null ? canisterStats.cycles.toLocaleString() : "unavailable"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#4a5568]">Memory</span>
                  <span className="text-[#e2e8f0] font-mono">{canisterStats.memory_size != null ? formatBytes(canisterStats.memory_size) : "unavailable"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#4a5568]">Status</span>
                  <span className="text-[#e2e8f0]">{canisterStats.status ?? "unavailable"}</span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-[#1e2d47] mt-2">
              <span className="text-[#4a5568]">Last updated</span>
              <span className="text-[#e2e8f0]">{lastUpdated ? relativeTime(lastUpdated) : "unknown"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** "each one take user to Files, Bucket, Usage Explorer" (the user's own
 * framing) - three real views over one asset-storage canister's own real
 * `list()`/`get_state_info()` data (see `lib/assetStorage.ts`'s own doc
 * comment). All public queries on the real canister - no controller
 * gating, unlike Auth's user-management surface. */
export default function StorageDetailPage() {
  const { job, loadError } = useOutletContext<ProjectContext>();
  const { canisterId } = useParams<{ canisterId: string }>();
  const [tab, setTab] = useState<TabId>("files");
  const [files, setFiles] = useState<AssetFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [canisterStats, setCanisterStats] = useState<CanisterStats | null>(null);
  const [canisterName, setCanisterName] = useState(canisterId ?? "");

  const network = job?.network ?? "local";
  // Derived from the already-fetched `files` themselves rather than a
  // separate `get_state_info` call - see `lib/assetStorage.ts::latestModified`'s
  // own doc comment on why (not reachable via the official `AssetManager`'s
  // public surface).
  const lastUpdated = files ? latestModified(files) : null;

  const load = () => {
    if (!canisterId) return;
    setLoading(true);
    setFilesError(null);
    listAssets(canisterId, network)
      .then(setFiles)
      .catch((e) => setFilesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    getCanisterStatsDirect(canisterName ?? "", canisterId, "static", network).then(setCanisterStats);
  };

  useEffect(() => {
    if (!canisterId || !job) return;
    let cancelled = false;
    void listStorageCanisters(job).then((storages) => {
      if (!cancelled) {
        setCanisterName(storages.find((storage) => storage.id === canisterId)?.name ?? canisterId);
      }
    });
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canisterId, job]);

  const handleUpload = async (file: File) => {
    if (!canisterId) return;
    setUploading(true);
    try {
      const key = await uploadFile(canisterId, network, file);
      toast.success("Uploaded", `${key} stored on ${canisterName}.`);
      load();
    } catch (e) {
      toast.error("Upload failed", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (key: string) => {
    if (!canisterId) return;
    setBusyKey(key);
    try {
      await deleteAsset(canisterId, network, key);
      toast.success("Deleted", `${key} removed.`);
      setFiles((prev) => prev?.filter((f) => f.key !== key) ?? prev);
    } catch (e) {
      toast.error("Delete failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <Link to={`/project/${job.id}/storage`} className="inline-flex items-center gap-1 text-xs text-[#4a5568] hover:text-[#e2e8f0] transition-colors mb-2">
            <ArrowLeft size={12} /> Back to Storage
          </Link>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <HardDrive size={18} className="text-[#00d4ff]" /> {canisterName}
          </h2>
          <div className="flex items-center gap-2 mt-1">
            <CanisterID id={canisterId ?? ""} className="text-xs" />
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      <div className="flex gap-1 border-b border-[#1e2d47]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-sm transition-colors border-b-2 -mb-px ${
              tab === t.id ? "text-[#00d4ff] border-[#00d4ff]" : "text-[#8892a4] border-transparent hover:text-[#e2e8f0]"
            }`}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {filesError && <p className="text-sm text-[#ff5252]">Couldn't load files: {filesError}</p>}
      {!filesError && files === null && <p className="text-sm text-[#4a5568]">Loading files…</p>}
      {!filesError && files !== null && canisterId && (
        <>
          {tab === "files" && (
            <FilesTab
              files={files}
              canisterId={canisterId}
              network={network}
              onUpload={handleUpload}
              onDelete={handleDelete}
              busyKey={busyKey}
              uploading={uploading}
            />
          )}
          {tab === "bucket" && <BucketTab files={files} canisterId={canisterId} network={network} />}
          {tab === "usage" && <UsageExplorerTab files={files} lastUpdated={lastUpdated} canisterStats={canisterStats} />}
        </>
      )}
    </div>
  );
}
