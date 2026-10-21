// "View Data" - `/project/:id/canister/:canisterId/view-data`, reached
// from the icon-only action on that canister's card in Overview.tsx (shown
// whenever that canister reports an `admin_panel_url` - see
// `lib/moduleConfig.ts::getModuleLinks`). Embeds that URL directly in an
// iframe rather than opening it in a new tab, so a canister's own admin UI
// (e.g. `ic-sql`'s embedded `table-browser`, whose `/admin/` route is
// expanded by `getModuleLinks` for the project's local/mainnet network)
// stays inside this dashboard.
//
// Also bridges this dashboard's own signed-in identity into that iframe
// (see `lib/moduleDelegation.ts`'s own doc comment for the full protocol)
// so the embedded module can act as the real signed-in user, scoped to
// just this one canister, instead of needing its own separate Internet
// Identity login.

import { useEffect, useRef, useState } from "react";
import { useOutletContext, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { ProjectContext } from "@/components/layout/AppShell";
import { getModuleLinks } from "@/lib/moduleConfig";
import { setupModuleDelegationBridge } from "@/lib/moduleDelegation";

export default function CanisterViewData() {
  const { job, loadError } = useOutletContext<ProjectContext>();
  const { canisterId } = useParams<{ canisterId: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [adminPanelUrl, setAdminPanelUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || !canisterId) return;
    setLoaded(false);
    setError(null);
    getModuleLinks(canisterId, job.network)
      .then(({ adminPanelUrl }) => setAdminPanelUrl(adminPanelUrl))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, [job?.id, job?.network, canisterId]);

  // Set up once the iframe actually exists and we know both its real
  // origin (from `adminPanelUrl`) and which canister it's allowed to be -
  // re-run if either changes (e.g. navigating this same page to a
  // different canister without a full remount).
  useEffect(() => {
    if (!canisterId || !adminPanelUrl || !iframeRef.current) return;
    const expectedOrigin = new URL(adminPanelUrl).origin;
    return setupModuleDelegationBridge(iframeRef.current, expectedOrigin, canisterId);
  }, [canisterId, adminPanelUrl]);

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job || !canisterId) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 flex-shrink-0 flex items-center gap-3 px-4 border-b border-[#1e2d47]">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-xs text-[#4a5568] hover:text-[#e2e8f0] transition-colors"
        >
          <ArrowLeft size={12} /> Back
        </button>
        <span className="text-xs text-[#8892a4] font-mono truncate">{canisterId}</span>
      </div>
      <div className="flex-1 min-h-0">
        {!loaded && <div className="p-6 text-sm text-[#4a5568]">Loading…</div>}
        {loaded && error && <div className="p-6 text-sm text-[#ff5252]">{error}</div>}
        {loaded && !error && !adminPanelUrl && (
          <div className="p-6 text-sm text-[#4a5568]">This canister doesn't expose an admin panel.</div>
        )}
        {loaded && !error && adminPanelUrl && (
          <iframe ref={iframeRef} src={adminPanelUrl} title="Canister admin panel" className="w-full h-full border-0" />
        )}
      </div>
    </div>
  );
}
