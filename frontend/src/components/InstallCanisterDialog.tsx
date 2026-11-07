import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Sparkles, Package, Loader2 } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { MarketplaceItemType } from "@/bindings/backend";
import { Dialog, DialogHeader, DialogContent } from "@/components/ui/Dialog";
import { formatMarketplacePrice, listMarketplaceItems, purchasedMarketplaceItemIds, type MarketplaceItem } from "@/lib/marketplace";
import { deployMarketplaceItem, type DeployedCanister } from "@/lib/deploy";
import { useAuth } from "@/lib/auth";
import { toast } from "@/components/Toast";
import { listPackageInfos, packageShaHex } from "@/lib/packageRegistry";

interface InstallCanisterDialogProps {
  open: boolean;
  onClose: () => void;
  jobId: string;
  network: string;
  /** Called right after a real deploy succeeds, so the caller can
   * `refetch()` the project - `deployMarketplaceItem` already recorded the
   * new canister on `backend` itself by the time this fires. */
  onDeployed: (canister?: DeployedCanister) => void;
  /** Pre-fills (and immediately filters by) a keyword when a specific page's
   * own empty state opens this dialog - e.g. Auth's "Browse Market" seeds
   * "auth" so the list starts narrowed to auth-shaped items instead of the
   * whole catalog. `MarketplaceItem` has no structured category/kind field
   * of its own (see the generated backend binding), so this is real title/
   * description text search, the same filter the box already runs on
   * every keystroke - not a second, fabricated classification. Still just
   * the starting text: fully editable/clearable like any other search. */
  initialQuery?: string;
  /** Restrict the catalog to the package a dynamic config field requires. */
  requiredPackageName?: string;
  /** Return to the caller after installation instead of opening Orchestrate. */
  navigateToOrchestrate?: boolean;
}

/** "create and deploy, opens a marketplace dialog, with search input... with
 * Create Custom Canister with A.I list item as first" (the user's own
 * framing) - the Overview page's "Create & Deploy a Canister" button opens
 * this. The catalog is the real `backend` marketplace (`list_marketplace_items`) -
 * selecting an item runs the real frontend-driven deploy flow
 * (`lib/deploy.ts`: download/decrypt wasm, create canister, install code, set
 * controllers) and then hands off to Orchestrate with the new canister's id
 * seeded into the input, so a follow-up AI request already knows which
 * canister it's about. "Create Custom Canister with AI" (always listed
 * first, exactly for when nothing below matches) hands off with no seed at
 * all - a normal fresh Orchestrate conversation. No orchestrator HTTP call
 * anywhere in this component. */
export function InstallCanisterDialog({ open, onClose, jobId, network, onDeployed, initialQuery, requiredPackageName, navigateToOrchestrate = true }: InstallCanisterDialogProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [items, setItems] = useState<MarketplaceItem[] | null>(null);
  const [packageNamesByItem, setPackageNamesByItem] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deployingId, setDeployingId] = useState<bigint | null>(null);
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { principal } = useAuth();

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery ?? "");
    setDeployingId(null);
    setPurchasedIds(new Set());
    setLoadError(null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    Promise.all([listMarketplaceItems(), listPackageInfos().catch(() => [])])
      .then(async ([marketplaceItems, packageInfos]) => {
        const packages = marketplaceItems.filter((item) => item.item_type === MarketplaceItemType.Package);
        setItems(packages);
        const namesByItem: Record<string, string> = {};
        for (const item of packages) {
          const hash = packageShaHex(item.wasm_hash);
          const info = packageInfos.find((candidate) => candidate.sha === hash);
          if (info) namesByItem[item.id.toString()] = info.name;
        }
        setPackageNamesByItem(namesByItem);
        setPurchasedIds(await purchasedMarketplaceItemIds(packages));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const all = items ?? [];
    const normalizePackageName = (name: string) => name.trim().toLowerCase().replace(/\.wasm$/, "").replaceAll("_", "-");
    const required = requiredPackageName ? normalizePackageName(requiredPackageName) : null;
    const q = query.toLowerCase().trim();
    return all.filter((item) => {
      if (required) {
        const packageNames = [item.package_slug, packageNamesByItem[item.id.toString()], item.title];
        if (!packageNames.some((name) => name && normalizePackageName(name) === required)) return false;
      }
      return !q || item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
    });
  }, [items, packageNamesByItem, query, requiredPackageName]);

  const goToOrchestrate = (seed?: string) => {
    onClose();
    navigate(`/project/${jobId}/orchestrate`, seed ? { state: { seed } } : undefined);
  };

  const install = async (item: MarketplaceItem) => {
    if (!principal) {
      toast.error("Not signed in", "Sign in again and retry.");
      return;
    }
    setDeployingId(item.id);
    try {
      const result = await deployMarketplaceItem(item, network, jobId, Principal.fromText(principal));
      toast.success(`${item.title} deployed`, `Canister "${result.name}" (${result.id}) is live.`);
      onDeployed(result);
      if (navigateToOrchestrate) {
        goToOrchestrate(`I just deployed a new "${item.title}" canister, id ${result.id} (named "${result.name}"). Help me wire it up into this project.`);
      } else {
        onClose();
      }
    } catch (e) {
      toast.error(`Couldn't deploy ${item.title}`, e instanceof Error ? e.message : String(e));
      setDeployingId(null);
    }
  };

  return (
    <Dialog open={open} onClose={() => deployingId === null && onClose()}>
      <DialogHeader title={requiredPackageName ? `Install ${requiredPackageName}` : "Create & Deploy a Canister"} onClose={deployingId === null ? onClose : undefined} />
      <DialogContent className="space-y-3">
        {!requiredPackageName && <div className="flex items-center gap-2 px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg focus-within:border-[#00d4ff55] transition-colors">
          <Search size={15} className="text-[#4a5568] flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={deployingId !== null}
            placeholder="Search the marketplace for a canister to install…"
            className="flex-1 bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none disabled:opacity-50"
          />
        </div>}

        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {!requiredPackageName && <button
            onClick={() => goToOrchestrate()}
            disabled={deployingId !== null}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-[#00d4ff33] bg-[#00d4ff0a] hover:bg-[#00d4ff14] transition-colors text-left disabled:opacity-50"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center flex-shrink-0">
              <Sparkles size={15} className="text-[#00d4ff]" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#00d4ff]">Create Custom Canister with AI</div>
              <div className="text-[11px] text-[#4a5568]">Can't find what you need below? Describe it and Secretary will build it.</div>
            </div>
          </button>}

          {loadError && <p className="text-xs text-[#ff5252] px-1 py-2">Couldn't load the marketplace: {loadError}</p>}
          {!loadError && items === null && <p className="text-xs text-[#4a5568] px-1 py-2">Loading marketplace…</p>}

          {items !== null &&
            (filtered.length > 0 ? (
              filtered.map((item) => {
                const idText = item.id.toString();
                const isDeploying = deployingId === item.id;
                const gated = item.encrypted_key !== undefined;
                const purchased = purchasedIds.has(idText);
                return (
                  <button
                    key={idText}
                    onClick={() => install(item)}
                    disabled={deployingId !== null}
                    className="w-full flex items-center gap-3 p-3 rounded-lg border border-[#1e2d47] hover:bg-[#131929] hover:border-[#00d4ff44] transition-colors text-left disabled:opacity-50"
                  >
                    <div className="w-8 h-8 rounded-lg bg-[#1a2236] text-[#8892a4] flex items-center justify-center flex-shrink-0">
                      {isDeploying ? <Loader2 size={15} className="animate-spin" /> : <Package size={15} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#e2e8f0] truncate">{item.title}</span>
                        {gated && item.price != null && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${purchased ? "border-[#00d4ff44] bg-[#00d4ff12] text-[#00d4ff]" : "border-[#ffab4044] bg-[#ffab4022] text-[#ffab40]"}`}>
                            {purchased ? "Download" : formatMarketplacePrice(item.price)}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#4a5568] truncate">
                        {isDeploying ? "Deploying - downloading and installing the real canister…" : item.description}
                      </div>
                    </div>
                  </button>
                );
              })
            ) : (
              <p className="text-xs text-[#4a5568] px-1 py-2">
                {requiredPackageName
                  ? `The marketplace does not currently list the required package ${requiredPackageName}.`
                  : items.length === 0 ? "The marketplace is empty right now." : `No installable canister matches "${query}" - try Create Custom Canister with AI above.`}
              </p>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
