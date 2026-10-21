import { useState } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { HardDrive, ChevronRight, RefreshCw, Sparkles, FolderOpen, Globe, Gauge, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { InstallCanisterDialog } from "@/components/InstallCanisterDialog";
import type { ProjectContext } from "@/components/layout/AppShell";
import { listStorageCanisters } from "@/lib/assetStorage";

/** Shown instead of the canister grid while a project has no asset-storage
 * canister yet - matches `Auth.tsx`'s own empty-state styling. The feature
 * chips describe what the real asset-canister recipe actually provides
 * (the standard IC certified-assets interface), not aspirational copy.
 * "Browse Market" opens the same real marketplace install dialog
 * Overview's own empty state uses. */
function StorageEmptyState({ onAskAI, onBrowseMarket }: { onAskAI: () => void; onBrowseMarket: () => void }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-14 rounded-xl border border-dashed border-[#1e2d47] bg-[#0d1526]">
      <div className="relative mb-5">
        <div className="absolute inset-0 blur-2xl bg-[#00e67622] rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00e67622] to-[#00d4ff22] border border-[#00e67633] flex items-center justify-center">
          <HardDrive size={24} className="text-[#00e676]" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">No storage canister yet</h3>
      <p className="text-sm text-[#4a5568] max-w-md mb-5">
        A real place to store media and files this project references - images, documents, anything served
        directly over HTTP, certified and cached like any other asset on the IC.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00e6760d] border border-[#00e67622] text-[10px] text-[#8892a4]">
          <FolderOpen size={11} className="text-[#00e676]" /> Certified assets
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00d4ff0d] border border-[#00d4ff22] text-[10px] text-[#8892a4]">
          <Globe size={11} className="text-[#00d4ff]" /> Served over HTTP
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#c084fc0d] border border-[#c084fc22] text-[10px] text-[#8892a4]">
          <Gauge size={11} className="text-[#c084fc]" /> Usage &amp; size explorer
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full border border-[#1e2d47] bg-[#131929] text-xs text-[#8892a4]">Coming soon</span>
        {/* Marketplace install dialog disabled for production launch (no funds yet) - see TODO.md
        <Button variant="primary" size="sm" className="gap-1.5" onClick={onBrowseMarket}>
          <Store size={14} /> Browse Market
        </Button>
        */}
        {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAskAI}>
          <Sparkles size={14} /> Ask AI to Add Storage
        </Button>
        */}
      </div>
    </div>
  );
}

/** "storage shows canister that are assets, each one take user to Files,
 * Bucket, Usage Explorer" (the user's own framing) - mirrors
 * `Auth.tsx`/`Database.tsx`'s exact list-then-drill-in pattern. Picking one
 * navigates to `/project/:id/storage/:canisterId` (`StorageDetail.tsx`).
 * No orchestrator call anywhere on this page (see the
 * `decouple-orchestrator-api` project notes) - getting one into a project
 * goes through Orchestrate. */
export default function StoragePage() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [showInstallDialog, setShowInstallDialog] = useState(false);

  const canisters = job ? listStorageCanisters(job) : null;

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <HardDrive size={18} className="text-[#00d4ff]" /> Storage
          </h2>
          <p className="text-sm text-[#4a5568] mt-1">This project's asset-storage canisters.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={refetch}>
            <RefreshCw size={13} /> Refresh
          </Button>
          {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
          {canisters && canisters.length > 0 && (
            <Button variant="primary" onClick={() => navigate(`/project/${job.id}/orchestrate`)}>
              <Sparkles size={14} /> Ask AI to Add Storage
            </Button>
          )}
*/}
        </div>
      </div>

      {canisters && canisters.length === 0 && (
        <StorageEmptyState onAskAI={() => navigate(`/project/${job.id}/orchestrate`)} onBrowseMarket={() => setShowInstallDialog(true)} />
      )}

      {canisters && canisters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {canisters.map((c) => (
            <Card
              key={c.id}
              className="cursor-pointer hover:border-[#00d4ff44] transition-colors group"
              onClick={() => navigate(`/project/${job.id}/storage/${c.id}`)}
            >
              <CardContent className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#00e67611] border border-[#00e67633] flex items-center justify-center flex-shrink-0">
                  <HardDrive size={16} className="text-[#00e676]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[#e2e8f0] truncate group-hover:text-[#00d4ff] transition-colors">{c.name}</div>
                  <div className="text-[10px] text-[#4a5568] font-mono truncate">{c.id}</div>
                </div>
                <ChevronRight size={16} className="text-[#4a5568] group-hover:text-[#00d4ff] transition-colors flex-shrink-0" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <InstallCanisterDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        jobId={job.id}
        network={job.network}
        onDeployed={refetch}
        initialQuery="storage"
      />
    </div>
  );
}
