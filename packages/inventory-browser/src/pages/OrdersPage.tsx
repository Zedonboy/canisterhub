import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/Field";
import { OrderDetail, STATUS_VARIANT } from "@/components/OrderDetail";
import { formatDate, formatMoney } from "@/lib/format";
import { OPEN_STATUSES, STATUS_LABEL } from "@/lib/types";
import type { Order } from "@/lib/types";

type Filter = "all" | "open" | "Completed" | "Cancelled";

export default function OrdersPage({ orders, onChanged }: { orders: Order[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<bigint | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return orders.filter((o) => {
      if (filter === "open" && !OPEN_STATUSES.includes(o.status)) return false;
      if ((filter === "Completed" || filter === "Cancelled") && o.status !== filter) return false;
      return !q || o.id.toString() === q || (o.customerName ?? "").toLowerCase().includes(q) || (o.customerPhone ?? "").includes(q);
    });
  }, [orders, filter, query]);

  // look the open order up by id so the dialog reflects fresh data after a reload
  const open = orders.find((o) => o.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a5568]" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order no., customer or phone" className="pl-9" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
            { value: "Completed", label: "Completed" },
            { value: "Cancelled", label: "Cancelled" },
          ]}
        />
        <p className="lg:ml-auto text-[11px] text-[#4a5568]">Orders arrive through your connected sales agent.</p>
      </div>

      <div className="overflow-x-auto border border-[#1e2d47] rounded-lg bg-[#0d1526]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#4a5568] border-b border-[#1e2d47]">
              <th className="px-4 py-2.5 font-medium">Order</th>
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 font-medium text-right">Items</th>
              <th className="px-4 py-2.5 font-medium text-right">Total</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Placed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id.toString()} onClick={() => setOpenId(o.id)} className="border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] transition-colors cursor-pointer">
                <td className="px-4 py-2.5 font-mono text-[#e2e8f0]">#{o.id.toString()}</td>
                <td className="px-4 py-2.5">
                  <div className="text-[#e2e8f0]">{o.customerName ?? "—"}</div>
                  <div className="text-[11px] text-[#4a5568]">{o.customerPhone ?? o.channel}</div>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[#8892a4]">{o.lines.length}</td>
                <td className="px-4 py-2.5 text-right font-mono">{formatMoney(o.totalMinor, o.currency)}</td>
                <td className="px-4 py-2.5"><Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge></td>
                <td className="px-4 py-2.5 text-[#8892a4]">{formatDate(o.createdAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-[#4a5568]">
                  {orders.length === 0 ? "No orders yet - they'll appear here as customers order." : "No orders match those filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && <OrderDetail order={open} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </div>
  );
}
