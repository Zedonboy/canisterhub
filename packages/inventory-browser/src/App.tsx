import { useState } from "react";
import { Package, LayoutDashboard, Boxes, ClipboardList, RefreshCw, LogIn, LogOut, Settings } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/Button";
import { BusinessForm } from "@/components/BusinessForm";
import { useAuth } from "@/lib/auth";
import { useStorageCanisterId } from "@/lib/storageCanister";
import { useInventory } from "@/lib/useInventory";
import OverviewPage from "@/pages/OverviewPage";
import InventoryPage from "@/pages/InventoryPage";
import OrdersPage from "@/pages/OrdersPage";

type Tab = "overview" | "inventory" | "orders";

const TABS: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "orders", label: "Orders", icon: ClipboardList },
];

/** Embedded in the dashboard with a working delegation (`delegated` - see
 * `lib/auth.ts`), this app already acts as the signed-in dashboard user, so
 * there's nothing to sign in or out of; only the principal shows. Standalone
 * it's the real Internet Identity sign-in. */
function AuthControl() {
  const { status, principal, delegated, signIn, signOut } = useAuth();
  if (status === "loading") return null;
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline text-[10px] text-[#4a5568] font-mono truncate max-w-[140px]" title={principal ?? undefined}>{principal}</span>
        {!delegated && (
          <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => undefined)}>
            <LogOut size={13} /> Sign out
          </Button>
        )}
      </div>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => signIn().catch(() => undefined)}>
      <LogIn size={13} /> Sign in
    </Button>
  );
}

/** Inventory & orders for a small business, backed by the `order_inventory`
 * canister that serves this page. Every data call is a controller-only
 * Candid method called as the signed-in user (see `lib/api.ts`). */
export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [editingBusiness, setEditingBusiness] = useState(false);
  const auth = useAuth();
  const storageId = useStorageCanisterId();
  const { business, items, orders, error, reload } = useInventory(auth.status !== "loading", auth.principal);

  const loaded = business !== null && items !== null && orders !== null;

  return (
    <div className="flex flex-col h-full">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 sm:px-6 py-3 border-b border-[#1e2d47] bg-[#0a0e1a]">
        <div className="flex items-center gap-2 text-[#e2e8f0] font-semibold min-w-0">
          <Package size={18} className="text-[#00d4ff] flex-shrink-0" />
          <span className="truncate">{business?.name || "Inventory & Orders"}</span>
          {loaded && (
            <button onClick={() => setEditingBusiness(true)} className="text-[#4a5568] hover:text-[#e2e8f0]" title="Business details" aria-label="Business details">
              <Settings size={13} />
            </button>
          )}
        </div>
        <nav className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors",
                tab === id ? "text-[#00d4ff] bg-[#00d4ff11] border border-[#00d4ff22]" : "text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] border border-transparent"
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            <RefreshCw size={13} /> Refresh
          </Button>
          <AuthControl />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <div className="max-w-6xl mx-auto">
          {error?.kind === "unauthorized" && (
            <div className="rounded-lg border border-[#1e2d47] bg-[#0d1526] p-6 text-center space-y-2">
              <p className="text-sm text-[#e2e8f0]">
                {auth.sessionEnded ? "Your dashboard session has ended." : "Only this canister's controllers can manage inventory and orders."}
              </p>
              <p className="text-xs text-[#4a5568]">
                {auth.sessionEnded
                  ? "Sign in again on the dashboard - this page picks the session back up within about 30 seconds."
                  : auth.status === "authenticated"
                    ? "The signed-in identity isn't a controller of this canister."
                    : "Sign in with the identity that controls it."}
              </p>
            </div>
          )}
          {error?.kind === "failed" && <p className="mb-4 text-sm text-[#ff5252]">Couldn't load data: {error.message}</p>}
          {!error && !loaded && <p className="text-sm text-[#4a5568]">Loading…</p>}
          {loaded && (
            <>
              {tab === "overview" && <OverviewPage business={business} items={items} orders={orders} onOpenTab={setTab} />}
              {tab === "inventory" && <InventoryPage business={business} items={items} imagesEnabled={!!storageId} onChanged={() => void reload()} />}
              {tab === "orders" && <OrdersPage orders={orders} onChanged={() => void reload()} />}
            </>
          )}
        </div>
      </main>

      {editingBusiness && business && <BusinessForm business={business} onClose={() => setEditingBusiness(false)} onSaved={() => void reload()} />}
    </div>
  );
}
