import type { ReactNode } from "react";
import { Boxes, AlertTriangle, ClipboardList, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { STATUS_VARIANT } from "@/components/OrderDetail";
import { StockBadge } from "@/pages/InventoryPage";
import { formatDate, formatMoney } from "@/lib/format";
import { OPEN_STATUSES, STATUS_LABEL, stockLevel } from "@/lib/types";
import type { Business, InventoryItem, Order } from "@/lib/types";

function Stat({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-[#1e2d47] bg-[#0d1526] p-4">
      <div className="flex items-center gap-2 text-xs text-[#8892a4]">
        <span style={{ color: tone ?? "#00d4ff" }}>{icon}</span> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold font-mono text-[#e2e8f0]">{value}</div>
      {sub && <div className="text-[11px] text-[#4a5568] mt-1">{sub}</div>}
    </div>
  );
}

export default function OverviewPage({ business, items, orders, onOpenTab }: { business: Business; items: InventoryItem[]; orders: Order[]; onOpenTab: (tab: "inventory" | "orders") => void }) {
  const products = items.filter((i) => i.kind === "Product").length;
  const attention = items.filter((i) => i.active && (stockLevel(i) === "low" || stockLevel(i) === "out"));
  const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
  const completed = orders.filter((o) => o.status === "Completed");
  // only orders in the business's own currency are summed - adding across currencies would be meaningless
  const revenue = completed.filter((o) => o.currency === business.currency).reduce((sum, o) => sum + o.totalMinor, 0n);
  const otherCurrency = completed.some((o) => o.currency !== business.currency);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={<Boxes size={14} />} label="Items" value={String(items.length)} sub={`${products} products · ${items.length - products} services`} />
        <Stat icon={<AlertTriangle size={14} />} label="Needs restock" value={String(attention.length)} sub="low or out of stock" tone={attention.length ? "#ffab40" : "#00e676"} />
        <Stat icon={<ClipboardList size={14} />} label="Open orders" value={String(open.length)} sub="not yet completed or cancelled" />
        <Stat
          icon={<TrendingUp size={14} />}
          label="Completed sales"
          value={formatMoney(revenue, business.currency)}
          sub={`${completed.length} order${completed.length === 1 ? "" : "s"}${otherCurrency ? " · other currencies not summed" : ""}`}
          tone="#00e676"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-[#1e2d47] bg-[#0d1526]">
          <header className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d47]">
            <h3 className="text-sm font-semibold text-[#e2e8f0]">Needs restock</h3>
            <button onClick={() => onOpenTab("inventory")} className="text-xs text-[#00d4ff] hover:underline">View inventory</button>
          </header>
          {attention.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[#4a5568]">Nothing is running low.</p>
          ) : (
            <ul>
              {attention.map((i) => (
                <li key={i.id.toString()} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#1e2d47] last:border-0">
                  <div className="text-sm text-[#e2e8f0] truncate">{i.name}</div>
                  <StockBadge item={i} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-[#1e2d47] bg-[#0d1526]">
          <header className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d47]">
            <h3 className="text-sm font-semibold text-[#e2e8f0]">Recent orders</h3>
            <button onClick={() => onOpenTab("orders")} className="text-xs text-[#00d4ff] hover:underline">View orders</button>
          </header>
          {orders.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[#4a5568]">No orders yet.</p>
          ) : (
            <ul>
              {orders.slice(0, 6).map((o) => (
                <li key={o.id.toString()} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#1e2d47] last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm text-[#e2e8f0] truncate">
                      <span className="font-mono">#{o.id.toString()}</span> · {o.customerName ?? "Customer"}
                    </div>
                    <div className="text-[11px] text-[#4a5568]">{formatDate(o.createdAt)}</div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-mono text-sm">{formatMoney(o.totalMinor, o.currency)}</span>
                    <Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
