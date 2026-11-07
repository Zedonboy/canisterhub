// "View Data" - `/project/:id/canister/:canisterId/view-data[?link=<n>]`,
// the in-dashboard viewer for every page a module declares through
// `get_links` (see `lib/moduleConfig.ts::getModuleLinks`). It is reached
// from the icon actions on that canister's card in Overview.tsx and from the
// card's `⋮` menu. `?link=<n>` picks the n-th declared link, so each page of a
// module has its own route; without it (or with an index that names nothing)
// the first `Admin` link opens, else the first link of any kind.
//
// Every link opens in an iframe here rather than a new tab - `Admin` pages
// (e.g. `ic-sql`'s embedded `table-browser`) and `Public` pages (e.g. a
// storefront) alike - so everything a module offers stays inside this
// dashboard; the header's tabs switch between a module's pages and its
// "open in new tab" button is the escape hatch. Relative URLs are already
// expanded by `getModuleLinks` for the project's local/mainnet network.
//
// Identity is the one thing the two kinds do NOT share. Only an `Admin` page
// - declared by the module as owner-only - gets this dashboard's signed-in
// identity bridged into it (see `lib/moduleDelegation.ts`'s own doc comment
// for the full protocol), so it can act as the real signed-in user, scoped to
// just this one canister, with no separate Internet Identity login. A `Public`
// page is embedded as the public would see it: it signs customers in with
// their own identity and is never handed the owner's.

import { useEffect, useRef, useState } from "react";
import { useOutletContext, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { AppWindow, ArrowLeft, ExternalLink } from "lucide-react";
import { clsx } from "clsx";
import type { ProjectContext } from "@/components/layout/AppShell";
import { getModuleLinks, type CanisterLink } from "@/lib/moduleConfig";
import { setupModuleDelegationBridge } from "@/lib/moduleDelegation";

/** Which declared link `?link=` selects - see this file's doc comment. */
function pickLink(links: CanisterLink[], param: string | null): number {
  if (param !== null && /^\d+$/.test(param) && Number(param) < links.length) return Number(param);
  const firstAdmin = links.findIndex((link) => "Admin" in link.kind);
  return firstAdmin >= 0 ? firstAdmin : links.length > 0 ? 0 : -1;
}

export default function CanisterViewData() {
  const { job, loadError } = useOutletContext<ProjectContext>();
  const { canisterId } = useParams<{ canisterId: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const linkParam = searchParams.get("link");

  const [links, setLinks] = useState<CanisterLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || !canisterId) return;
    setLoaded(false);
    setError(null);
    getModuleLinks(canisterId, job.network)
      .then(setLinks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, [job?.id, job?.network, canisterId]);

  const index = pickLink(links, linkParam);
  const page = index >= 0 ? links[index] : null;
  const pageUrl = page?.url ?? null;
  const isAdmin = page ? "Admin" in page.kind : false;

  // Set up once the iframe actually exists and we know both its real
  // origin (from `pageUrl`) and which canister it's allowed to be - re-run
  // if either changes (e.g. switching pages, or navigating this same route
  // to a different canister without a full remount). Admin pages only: see
  // this file's doc comment on why a Public page never gets this.
  useEffect(() => {
    if (!canisterId || !pageUrl || !isAdmin || !iframeRef.current) return;
    const expectedOrigin = new URL(pageUrl).origin;
    // The delegation covers every canister of this project (not just the
    // one being shown), so an embedded page can reach whichever sibling
    // canisters it needs - storage for images, notifications, the database.
    const projectCanisterIds = job ? Object.values(job.canisters).map((info) => info.id) : [];
    return setupModuleDelegationBridge(iframeRef.current, expectedOrigin, canisterId, projectCanisterIds);
  }, [canisterId, pageUrl, isAdmin, job]);

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
          className="flex items-center gap-1.5 text-xs text-[#4a5568] hover:text-[#e2e8f0] transition-colors flex-shrink-0"
        >
          <ArrowLeft size={12} /> Back
        </button>
        {links.length > 1 ? (
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto" role="tablist" aria-label="Pages">
            {links.map((link, i) => (
              <button
                key={`${i}:${link.label}`}
                role="tab"
                aria-selected={i === index}
                onClick={() => setSearchParams({ link: String(i) }, { replace: true })}
                className={clsx(
                  "px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors",
                  i === index ? "bg-[#00d4ff11] text-[#00d4ff] border border-[#00d4ff33]" : "text-[#8892a4] border border-transparent hover:bg-[#1a2236] hover:text-[#e2e8f0]",
                )}
              >
                {link.label}
              </button>
            ))}
          </div>
        ) : (
          page && <span className="text-xs text-[#e2e8f0] truncate">{page.label}</span>
        )}
        <span className="text-xs text-[#8892a4] font-mono truncate ml-auto">{canisterId}</span>
        {pageUrl && <CopyLinkButton url={pageUrl} label={page?.label ?? "this page"} />}
        {pageUrl && (
          <a
            href={pageUrl}
            target="_blank"
            rel="noreferrer"
            title="Open in a new tab"
            className="p-1 rounded text-[#8892a4] hover:bg-[#1a2236] hover:text-[#00d4ff] transition-colors flex-shrink-0"
          >
            <ExternalLink size={13} />
          </a>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {!loaded && <div className="p-6 text-sm text-[#4a5568]">Loading…</div>}
        {loaded && error && <div className="p-6 text-sm text-[#ff5252]">{error}</div>}
        {loaded && !error && !pageUrl && (
          <div className="p-6 text-sm text-[#4a5568] flex items-center gap-2">
            <AppWindow size={14} /> This canister doesn't declare any pages.
          </div>
        )}
        {loaded && !error && pageUrl && (
          // `key` remounts the frame per page so one page's state (and its
          // delegation bridge) never carries over into the next. The
          // sandbox deliberately keeps `allow-same-origin`: the embedded
          // module's origin must stay real for the delegation handshake's
          // origin check (and for its own session storage). What the
          // sandbox still blocks is the dangerous stuff a self-declared
          // module page could otherwise do to the dashboard: top-window
          // navigation (phishing redirects), native dialogs, downloads,
          // and plugins.
          <iframe
            key={pageUrl}
            ref={iframeRef}
            src={pageUrl}
            title={page?.label ?? "Canister page"}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            className="w-full h-full border-0"
          />
        )}
      </div>
    </div>
  );
}
