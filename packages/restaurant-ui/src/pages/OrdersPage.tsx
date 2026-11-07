import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/Modal";
import { Segmented } from "@/components/Field";
import { restaurantApi, type Order, type OrderState } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";

const key = (variant: object) => Object.keys(variant)[0];
const statusTone: Record<string, "amber" | "cyan" | "green" | "red" | "gray"> = { AwaitingPayment: "amber", Pending: "amber", Preparing: "cyan", Ready: "cyan", Served: "cyan", OutForDelivery: "cyan", Completed: "green", Cancelled: "red" };
const allowed: Record<string, OrderState[]> = {
  AwaitingPayment: [], Pending: ["Preparing", "Cancelled"], Preparing: ["Ready", "Cancelled"],
  Ready: ["Served", "OutForDelivery", "Cancelled"], Served: ["Completed"],
  OutForDelivery: ["Completed"], Completed: [], Cancelled: [],
};

function OrderDetail({ order, onClose, onChanged }: { order: Order; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = key(order.status);
  const update = async (next: OrderState) => {
    setBusy(true); setError(null);
    try { await restaurantApi.updateOrderStatus(order.id, next); onChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const collectCash = async () => {
    const receipt = window.prompt("Cash receipt/reference ID");
    if (!receipt?.trim()) return;
    setBusy(true); setError(null);
    try { await restaurantApi.recordCashCollection(order.id, receipt.trim()); onChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <Modal title={`Order #${order.id}`} onClose={busy ? () => undefined : onClose} wide>
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <div><div className="font-medium text-[#e2e8f0]">{order.customer_name[0] ?? "Customer"}</div><div className="text-xs text-[#8892a4]">{[order.customer_phone[0], key(order.customer.channel), order.customer.session_id].filter(Boolean).join(" · ")}</div><div className="text-xs text-[#4a5568]">{formatDateTime(Number(order.created_at / 1_000_000n))}</div></div>
        <Badge variant={statusTone[status] ?? "gray"}>{status}</Badge>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[#1e2d47]"><table className="w-full text-sm"><thead><tr className="text-left text-[11px] uppercase text-[#4a5568]"><th className="px-3 py-2">Dish</th><th className="px-3 py-2 text-right">Portions</th><th className="px-3 py-2 text-right">Plates</th><th className="px-3 py-2 text-right">Total</th></tr></thead><tbody>{order.items.map((line, index) => <tr key={`${line.menu_item_id}-${index}`} className="border-t border-[#1e2d47]"><td className="px-3 py-2 text-[#e2e8f0]">{line.name}<div className="text-[11px] text-[#4a5568]">{formatMoney(line.price_per_portion_minor, order.currency)} / portion + plate</div></td><td className="px-3 py-2 text-right">{line.portions.toString()}</td><td className="px-3 py-2 text-right">{line.plates.toString()}</td><td className="px-3 py-2 text-right">{formatMoney(line.line_total_minor, order.currency)}</td></tr>)}</tbody></table></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-[#1e2d47] p-3"><div className="text-xs text-[#4a5568]">Fulfillment</div><div className="mt-1 text-sm text-[#e2e8f0]">{key(order.fulfillment)}{order.delivery_address[0] ? ` · ${order.delivery_address[0]}` : ""}{order.table_label[0] ? ` · Table ${order.table_label[0]}` : ""}</div></div>
        <div className="rounded-lg border border-[#1e2d47] p-3"><div className="text-xs text-[#4a5568]">Payment</div><div className="mt-1 text-sm text-[#e2e8f0]">{key(order.payment_method)} · {key(order.payment_status)}</div></div>
      </div>
      {order.note[0] && <p className="text-sm text-[#8892a4]">Note: {order.note[0]}</p>}
      <div className="flex items-center justify-between border-t border-[#1e2d47] pt-3"><span className="font-semibold">Total</span><span className="font-mono text-lg">{formatMoney(order.total_minor, order.currency)}</span></div>
      {error && <p className="text-xs text-[#ff5252]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">{key(order.payment_status) === "CashOnDeliveryPending" && <Button variant="outline" size="sm" onClick={() => void collectCash()} disabled={busy}>Record cash payment</Button>}{allowed[status]?.map((next) => <Button key={next} variant={next === "Cancelled" ? "danger" : "primary"} size="sm" onClick={() => void update(next)} disabled={busy}>{next}</Button>)}</div>
    </div>
  </Modal>;
}

type Filter = "open" | "all" | "Completed" | "Cancelled";
export default function OrdersPage({ orders, onChanged }: { orders: Order[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<bigint | null>(null);
  const rows = useMemo(() => orders.filter((order) => {
    const status = key(order.status);
    if (filter === "open" && ["Completed", "Cancelled"].includes(status)) return false;
    if ((filter === "Completed" || filter === "Cancelled") && status !== filter) return false;
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return !q || order.id.toString() === q || (order.customer_name[0] ?? "").toLowerCase().includes(q) || (order.customer_phone[0] ?? "").includes(q);
  }), [orders, filter, query]);
  const selectedOrder = orders.find((order) => order.id === selected) ?? null;
  return <div className="space-y-4">
    <div className="flex flex-col lg:flex-row lg:items-center gap-3"><div className="relative flex-1 max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a5568]" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order, customer or phone" className="pl-9" /></div><Segmented value={filter} onChange={setFilter} options={[{ value: "open", label: "Open" }, { value: "all", label: "All" }, { value: "Completed", label: "Completed" }, { value: "Cancelled", label: "Cancelled" }]} /></div>
    <div className="overflow-x-auto border border-[#1e2d47] rounded-lg bg-[#0d1526]"><table className="w-full text-sm"><thead><tr className="text-left text-[11px] uppercase tracking-wide text-[#4a5568] border-b border-[#1e2d47]"><th className="px-4 py-2.5">Order</th><th className="px-4 py-2.5">Customer</th><th className="px-4 py-2.5 text-right">Lines</th><th className="px-4 py-2.5 text-right">Total</th><th className="px-4 py-2.5">Payment</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Placed</th></tr></thead><tbody>{rows.map((o) => <tr key={o.id.toString()} onClick={() => setSelected(o.id)} className="border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] cursor-pointer"><td className="px-4 py-2.5 font-mono">#{o.id.toString()}</td><td className="px-4 py-2.5"><div>{o.customer_name[0] ?? "Customer"}</div><div className="text-[11px] text-[#4a5568]">{o.customer_phone[0] ?? key(o.customer.channel)}</div></td><td className="px-4 py-2.5 text-right">{o.items.length}</td><td className="px-4 py-2.5 text-right font-mono">{formatMoney(o.total_minor, o.currency)}</td><td className="px-4 py-2.5 text-xs">{key(o.payment_status)}</td><td className="px-4 py-2.5"><Badge variant={statusTone[key(o.status)] ?? "gray"}>{key(o.status)}</Badge></td><td className="px-4 py-2.5 text-[#8892a4]">{formatDateTime(Number(o.created_at / 1_000_000n))}</td></tr>)}{rows.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-[#4a5568]">{orders.length ? "No orders match those filters." : "No orders yet. Orders from chat and the public storefront will appear here."}</td></tr>}</tbody></table></div>
    {selectedOrder && <OrderDetail order={selectedOrder} onClose={() => setSelected(null)} onChanged={onChanged} />}
  </div>;
}
