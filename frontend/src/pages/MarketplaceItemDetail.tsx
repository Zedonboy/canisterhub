import { useEffect, useState } from "react";
import { useOutletContext, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Package, Zap, Loader, Download, ExternalLink } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { formatMarketplacePrice, getMarketplaceItem, hasPurchasedMarketplaceItem, type MarketplaceItem } from "@/lib/marketplace";
import { deployMarketplaceItem } from "@/lib/deploy";
import { MOCK_MARKETPLACE_ITEMS } from "@/lib/mock-data";
import type { ProjectContext } from "@/components/layout/AppShell";

/** `/project/:id/overview/product/:product_id` - reached from a card in
 * `Overview.tsx`'s Marketplace section. A real marketplace item's own
 * `id` (`bigint`, as a string param) unless it's negative, which can only
 * ever be one of `MOCK_MARKETPLACE_ITEMS` (see that constant's own doc
 * comment on why real ids are never negative) - that case is resolved
 * locally, no backend call, and shown as a preview with no real Install.
 * Install here always targets *this* project directly (its `job.id` is
 * already known from the route), unlike the top-level `/market/product/:id`
 * product-category page, which still has to ask which project first. */
export default function MarketplaceItemDetail() {
  const { job, refetch } = useOutletContext<ProjectContext>();
  const { product_id = "" } = useParams();
  const navigate = useNavigate();
  const { principal } = useAuth();

  const isPreview = product_id.startsWith("-");
  const previewItem = isPreview ? MOCK_MARKETPLACE_ITEMS.find((p) => p.id.toString() === product_id) ?? null : null;

  const [item, setItem] = useState<MarketplaceItem | null>(previewItem);
  const [loaded, setLoaded] = useState(isPreview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [purchased, setPurchased] = useState(false);

  useEffect(() => {
    if (isPreview) return;
    let id: bigint;
    try {
      id = BigInt(product_id);
    } catch {
      setLoadError("Not a valid marketplace item id.");
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setLoadError(null);
    setPurchased(false);
    getMarketplaceItem(id)
      .then(async (nextItem) => {
        setItem(nextItem);
        if (nextItem?.price !== undefined) {
          setPurchased(await hasPurchasedMarketplaceItem(nextItem.id).catch(() => false));
        }
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, [isPreview, product_id, principal]);

  const install = async () => {
    if (!item || !job) return;
    if (!principal) {
      toast.error("Not signed in", "Sign in again and retry.");
      return;
    }
    setDeploying(true);
    try {
      const result = await deployMarketplaceItem(item, job.network, job.id, Principal.fromText(principal));
      toast.success(`${item.title} deployed`, `Canister "${result.name}" (${result.id}) is live.`);
      refetch();
      navigate(`/project/${job.id}/orchestrate`, {
        state: { seed: `I just deployed a new "${item.title}" canister, id ${result.id} (named "${result.name}"). Help me wire it up into this project.` },
      });
    } catch (e) {
      toast.error(`Couldn't deploy ${item.title}`, e instanceof Error ? e.message : String(e));
      setDeploying(false);
    }
  };

  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const back = () => navigate(`/project/${job.id}/overview`);

  return (
    <div className="p-4 sm:p-6 space-y-6 animate-fade-in max-w-3xl">
      <button
        onClick={back}
        className="flex items-center gap-2 text-sm text-[#4a5568] hover:text-[#e2e8f0] transition-colors"
      >
        <ArrowLeft size={15} /> Back to Overview
      </button>

      {!loaded && <p className="text-sm text-[#4a5568]">Loading…</p>}
      {loaded && loadError && <p className="text-sm text-[#ff5252]">Couldn't load this item: {loadError}</p>}
      {loaded && !loadError && !item && <p className="text-sm text-[#4a5568]">This marketplace item doesn't exist (any more).</p>}

      {item && (
        <>
          <div className="flex items-start justify-between gap-6">
            <div className="flex items-start gap-5">
              <div className="w-16 h-16 rounded-2xl bg-[#1a2236] border border-[#1e2d47] flex items-center justify-center flex-shrink-0">
                <Package size={26} className="text-[#8892a4]" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-xl font-bold text-[#e2e8f0]">{item.title}</h1>
                  {item.price != null && (
                    <Badge variant={purchased ? "cyan" : "amber"}>
                      {purchased ? "Download" : formatMarketplacePrice(item.price)}
                    </Badge>
                  )}
                  {isPreview && <Badge variant="cyan">Preview</Badge>}
                </div>
                <div className="flex items-center gap-3 text-xs text-[#4a5568]">
                  <span className="flex items-center gap-1"><Download size={11} /> {item.downloads.toString()} downloads</span>
                  {item.git_repo_url && (
                    <a href={item.git_repo_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#00d4ff] hover:underline">
                      <ExternalLink size={11} /> Source
                    </a>
                  )}
                </div>
              </div>
            </div>
            <Button
              variant="primary"
              className="gap-1.5 flex-shrink-0"
              disabled={isPreview || deploying}
              title={isPreview ? "Sample item - nothing to install yet" : undefined}
              onClick={install}
            >
              {deploying ? <Loader size={14} className="animate-spin" /> : <Zap size={14} fill="currentColor" />}
              {deploying
                ? purchased ? "Downloading & deploying…" : "Paying & deploying…"
                : purchased ? "Download & install" : item.price != null ? "Buy & install" : "Install"}
            </Button>
          </div>

          {isPreview && (
            <p className="text-xs text-[#c084fc] bg-[#c084fc0d] border border-[#c084fc33] rounded-lg px-3 py-2">
              This is a sample listing - nothing's been published to the marketplace yet, so there's no real canister
              to install here.
            </p>
          )}

          <div className="p-5 rounded-xl border border-[#1e2d47] bg-[#0d1526]">
            <h2 className="text-xs font-semibold text-[#4a5568] uppercase tracking-widest mb-2">Description</h2>
            <p className="text-sm text-[#6b7c93] leading-relaxed">{item.description}</p>
          </div>
        </>
      )}
    </div>
  );
}
