import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { clsx } from "clsx";
import { BookOpen, Boxes, ClipboardList, LayoutDashboard, LogIn, LogOut, Package, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { useRestaurant } from "@/lib/useRestaurant";
import { useStorageCanisterId } from "@/lib/storageCanister";
import MenuPage from "@/pages/MenuPage";
import OrdersPage from "@/pages/OrdersPage";
import StorefrontPage from "@/pages/StorefrontPage";

type Tab = "overview" | "menu" | "orders";
const tabs: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "menu", label: "Menu", icon: Boxes },
  { id: "orders", label: "Orders", icon: ClipboardList },
];
const variantName = (value: object) => Object.keys(value)[0];

function AdminApp() {
  const [tab, setTab] = useState<Tab>("overview");
  const auth = useAuth();
  const storageCanisterId = useStorageCanisterId();
  const { menu, orders, error, reload } = useRestaurant(auth.status !== "loading", auth.principal);
  const ready = menu !== null && orders !== null;
  return <div className="flex h-full flex-col">
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[#1e2d47] bg-[#0a0e1a] px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2 font-semibold text-[#e2e8f0]"><Package size={18} className="shrink-0 text-[#00d4ff]" /><span className="truncate">Restaurant &amp; Orders</span></div>
      <nav className="flex gap-1">{tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={clsx("inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs transition-colors", tab === id ? "border-[#00d4ff22] bg-[#00d4ff11] text-[#00d4ff]" : "border-transparent text-[#8892a4] hover:bg-[#131929] hover:text-[#e2e8f0]")}><Icon size={14} />{label}</button>)}</nav>
      <div className="ml-auto flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => void reload()}><RefreshCw size={13} /> Refresh</Button>{auth.status === "authenticated" ? <div className="flex items-center gap-2"><span className="hidden max-w-[140px] truncate font-mono text-[10px] text-[#4a5568] sm:inline">{auth.principal}</span>{!auth.delegated && <Button variant="ghost" size="sm" onClick={() => void auth.signOut()}><LogOut size={13} /> Sign out</Button>}</div> : auth.status !== "loading" && <Button variant="secondary" size="sm" onClick={() => void auth.signIn()}><LogIn size={13} /> Sign in</Button>}</div>
    </header>
    <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6"><div className="mx-auto max-w-6xl space-y-5">
      {error?.kind === "unauthorized" && <div className="rounded-lg border border-[#1e2d47] bg-[#0d1526] p-6 text-center"><p className="text-sm">Sign in with the identity that controls this restaurant canister.</p><p className="mt-2 text-xs text-[#4a5568]">Only controllers can manage the menu and orders.</p></div>}
      {error?.kind === "failed" && <p className="text-sm text-[#ff5252]">Couldn’t load restaurant data: {error.message}</p>}
      {!error && !ready && <p className="text-sm text-[#4a5568]">Loading restaurant data…</p>}
      {ready && tab === "overview" && <div className="space-y-5"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        { label: "Menu items", value: menu.length, icon: <BookOpen size={14} /> },
        { label: "Available now", value: menu.filter((i) => i.available).length, icon: <Boxes size={14} /> },
        { label: "Open orders", value: orders.filter((o) => !["Completed", "Cancelled"].includes(variantName(o.status))).length, icon: <ClipboardList size={14} /> },
        { label: "Orders today", value: orders.length, icon: <ClipboardList size={14} /> },
      ].map((stat) => <div key={stat.label} className="rounded-lg border border-[#1e2d47] bg-[#0d1526] p-4"><div className="flex items-center gap-2 text-xs text-[#8892a4]"><span className="text-[#00d4ff]">{stat.icon}</span>{stat.label}</div><div className="mt-2 font-mono text-2xl font-semibold">{stat.value}</div></div>)}</div><div className="rounded-lg border border-[#1e2d47] bg-[#0d1526]"><div className="flex items-center justify-between border-b border-[#1e2d47] px-4 py-3"><h2 className="text-sm font-semibold">Recent orders</h2><button onClick={() => setTab("orders")} className="text-xs text-[#00d4ff]">View all</button></div>{orders.slice(0, 5).map((order) => <div key={order.id.toString()} className="flex items-center justify-between gap-3 border-b border-[#1e2d47] px-4 py-3 last:border-0"><div><div className="text-sm">Order #{order.id.toString()} · {order.customer_name[0] ?? "Customer"}</div><div className="text-[11px] text-[#4a5568]">{order.items.length} dish lines · {variantName(order.status)}</div></div><div className="font-mono text-sm">{formatMoney(order.total_minor, order.currency)}</div></div>)}{orders.length === 0 && <p className="px-4 py-8 text-center text-sm text-[#4a5568]">Orders placed from chat and the public storefront will appear here.</p>}</div></div>}
      {ready && tab === "menu" && <MenuPage items={menu} storageEnabled={!!storageCanisterId} onChanged={() => void reload()} />}
      {ready && tab === "orders" && <OrdersPage orders={orders} onChanged={() => void reload()} />}
    </div></main>
  </div>;
}

export default function App() {
  return window.location.pathname.startsWith("/admin") ? <AdminApp /> : <StorefrontPage />;
}
