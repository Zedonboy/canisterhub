import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { inventoryApi } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { NEXT_STATUSES, STATUS_LABEL } from "@/lib/types";
import type { AuditEntry, Order, OrderStatus } from "@/lib/types";

export const STATUS_VARIANT = {
  AwaitingPayment: "amber",
  Pending: "amber",
  Confirmed: "cyan",
  Preparing: "cyan",
  Ready: "cyan",
  OutForDelivery: "cyan",
  Completed: "green",
  Cancelled: "red",
  Expired: "red",
} as const;

const ACTION_LABEL: Record<OrderStatus, string> = {
  AwaitingPayment: "Awaiting payment",
  Pending: "Pending",
  Confirmed: "Confirm",
  Preparing: "Start preparing",
  Ready: "Mark ready",
  OutForDelivery: "Out for delivery",
  Completed: "Mark completed",
  Cancelled: "Cancel order",
  Expired: "Expired",
};

export function OrderDetail({ order, onClose, onChanged }: { order: Order; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [paymentBusy, setPaymentBusy] = useState(false);

  useEffect(() => {
    inventoryApi.listAudit(order.id).then(setAudit).catch(() => setAudit([]));
  }, [order.id]);

  const move = async (status: OrderStatus) => {
    if (status === "Cancelled" && !window.confirm(`Cancel order #${order.id}? Its stock goes back on the shelf.`)) return;
    setBusy(status);
    setError(null);
    try {
      await inventoryApi.setOrderStatus(order.id, status);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const next = NEXT_STATUSES[order.status];
  const forward = next.filter((s) => s !== "Cancelled");
  const canCancel = next.includes("Cancelled");

  const collectCash = async () => {
    const receipt = window.prompt("Cash receipt/reference ID");
    if (!receipt?.trim()) return;
    setPaymentBusy(true);
    setError(null);
    try {
      await inventoryApi.recordCashCollection(order, receipt.trim());
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPaymentBusy(false);
    }
  };

  const recordRefund = async () => {
    const provider = window.prompt("Refund provider", "manual");
    if (!provider?.trim()) return;
    const transactionId = window.prompt("Provider refund transaction ID");
    if (!transactionId?.trim()) return;
    setPaymentBusy(true);
    setError(null);
    try {
      await inventoryApi.recordRefund(order, provider.trim(), transactionId.trim());
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPaymentBusy(false);
    }
  };

  return (
    <Modal title={`Order #${order.id}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-[#e2e8f0]">{order.customerName ?? "Customer"}</div>
            <div className="text-xs text-[#4a5568]">{[order.customerPhone, order.channel].filter(Boolean).join(" · ")}</div>
            <div className="text-xs text-[#4a5568]">Placed {formatDateTime(order.createdAt)}</div>
          </div>
          <Badge variant={STATUS_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
        </div>

        <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-3 text-sm">
          <div className="text-xs text-[#4a5568]">Payment</div>
          <div className="mt-1 text-[#e2e8f0]">
            {order.paymentMethod === "Prepaid" ? "Prepaid" : "Cash on delivery"} · {order.paymentStatus}
          </div>
          <div className="mt-1 font-mono text-xs text-[#8892a4]">
            Paid {formatMoney(order.amountPaidMinor, order.currency)}
            {order.amountRefundedMinor > 0n && <> · Refunded {formatMoney(order.amountRefundedMinor, order.currency)}</>}
          </div>
          {order.paymentReference && <div className="mt-1 break-all font-mono text-[11px] text-[#4a5568]">{order.paymentReference}</div>}
          {order.reservationExpiresAt && order.status === "AwaitingPayment" && (
            <div className="mt-1 text-xs text-[#f6c85f]">Stock reserved until {formatDateTime(order.reservationExpiresAt)}</div>
          )}
        </div>

        <div className="overflow-x-auto border border-[#1e2d47] rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#4a5568] border-b border-[#1e2d47]">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium text-right">Qty</th>
                <th className="px-3 py-2 font-medium text-right">Price</th>
                <th className="px-3 py-2 font-medium text-right">Line total</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.inventoryId.toString()} className="border-b border-[#1e2d47] last:border-0">
                  <td className="px-3 py-2 text-[#e2e8f0]">
                    {l.name} {l.kind === "Service" && <Badge variant="gray" className="ml-1">service</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{l.quantity.toString()}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatMoney(l.unitPriceMinor, order.currency)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatMoney(l.lineTotalMinor, order.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[#1e2d47]">
                <td colSpan={3} className="px-3 py-2 text-right text-[#8892a4]">Total</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-[#e2e8f0]">{formatMoney(order.totalMinor, order.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {(order.deliveryAddress || order.deliveryCoordinates || order.deliveryInstructions) && (
          <div className="text-sm text-[#8892a4] space-y-0.5">
            <div className="text-xs text-[#4a5568]">Delivery</div>
            {order.deliveryAddress && <div className="text-[#e2e8f0]">{order.deliveryAddress}</div>}
            {order.deliveryCoordinates && (
              <div className="font-mono text-xs">{order.deliveryCoordinates.latitude}, {order.deliveryCoordinates.longitude}</div>
            )}
            {order.deliveryInstructions && <div>{order.deliveryInstructions}</div>}
          </div>
        )}
        {order.note && <p className="text-sm text-[#8892a4]">Note: {order.note}</p>}

        <div className="rounded-lg border border-[#1e2d47] p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[#718096]">Audit trail</div>
          {audit.length === 0 ? (
            <p className="text-xs text-[#4a5568]">No audit entries available.</p>
          ) : (
            <div className="max-h-44 space-y-2 overflow-y-auto">
              {audit.map((entry) => (
                <div key={entry.id.toString()} className="border-b border-[#1e2d47] pb-2 text-xs last:border-0">
                  <div className="flex justify-between gap-2 text-[#e2e8f0]"><span>{entry.action}</span><span className="text-[#4a5568]">{formatDateTime(entry.at)}</span></div>
                  <div className="mt-0.5 break-all text-[#8892a4]">{entry.details}</div>
                  <div className="mt-0.5 break-all font-mono text-[10px] text-[#4a5568]">{entry.actor}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {error && <p className="text-xs text-[#ff5252]">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>Close</Button>
          {order.paymentMethod === "CashOnDelivery" && order.paymentStatus === "CashOnDeliveryPending" && (order.status === "Ready" || order.status === "OutForDelivery") && (
            <Button variant="secondary" onClick={collectCash} disabled={busy !== null || paymentBusy}>
              {paymentBusy && <Loader2 size={13} className="animate-spin" />} Record cash collected
            </Button>
          )}
          {order.paymentStatus === "RefundPending" && order.amountPaidMinor > order.amountRefundedMinor && (
            <Button variant="secondary" onClick={recordRefund} disabled={busy !== null || paymentBusy}>
              {paymentBusy && <Loader2 size={13} className="animate-spin" />} Record refund
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" onClick={() => move("Cancelled")} disabled={busy !== null}>
              {busy === "Cancelled" && <Loader2 size={13} className="animate-spin" />} {ACTION_LABEL.Cancelled}
            </Button>
          )}
          {forward.map((s, i) => (
            <Button key={s} variant={i === 0 ? "primary" : "secondary"} onClick={() => move(s)} disabled={busy !== null}>
              {busy === s && <Loader2 size={13} className="animate-spin" />} {ACTION_LABEL[s]}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
