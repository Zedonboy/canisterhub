import { useState } from "react";
import { Minus, Package, Plus, Wrench } from "lucide-react";
import { clsx } from "clsx";
import type { Kind, OrderStatus } from "@/lib/api";

export function ItemImage({ url, kind, alt, className }: { url: string | null; kind: Kind; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = kind === "Service" ? Wrench : Package;
  return (
    <div className={clsx("bg-c-surface2 overflow-hidden flex items-center justify-center", className)}>
      {url && !failed ? (
        <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" />
      ) : (
        <Icon size={32} className="text-c-faint" />
      )}
    </div>
  );
}

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-c-surface2 text-c-muted border border-c-line">
      {kind}
    </span>
  );
}

export function Stepper({ value, max, onChange, size = "md" }: { value: number; max?: number | null; onChange: (n: number) => void; size?: "sm" | "md" }) {
  const cap = max ?? 99;
  const btn = clsx(
    "flex items-center justify-center rounded border border-c-line bg-c-surface text-c-text disabled:opacity-40 hover:border-c-accent-a44",
    size === "sm" ? "w-7 h-7" : "w-9 h-9",
  );
  return (
    <div className="inline-flex items-center gap-1.5">
      <button className={btn} aria-label="Decrease quantity" onClick={() => onChange(value - 1)}>
        <Minus size={13} />
      </button>
      <span className={clsx("text-center tabular-nums text-sm", size === "sm" ? "w-6" : "w-8")} aria-live="polite">{value}</span>
      <button className={btn} aria-label="Increase quantity" disabled={value >= cap} onClick={() => onChange(value + 1)}>
        <Plus size={13} />
      </button>
    </div>
  );
}

const STATUS: Record<OrderStatus, { label: string; color: string }> = {
  AwaitingPayment: { label: "Awaiting payment", color: "var(--ch-email)" },
  Pending: { label: "Received", color: "var(--ch-email)" },
  Confirmed: { label: "Confirmed", color: "var(--accent)" },
  Preparing: { label: "Preparing", color: "var(--accent)" },
  Ready: { label: "Ready", color: "var(--accent)" },
  OutForDelivery: { label: "Out for delivery", color: "var(--accent)" },
  Completed: { label: "Completed", color: "var(--ch-whatsapp)" },
  Cancelled: { label: "Cancelled", color: "var(--danger)" },
  Expired: { label: "Expired", color: "var(--danger)" },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { label, color } = STATUS[status];
  return (
    <span
      className="text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {label}
    </span>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: React.ReactNode }) {
  const color = tone === "error" ? "var(--danger)" : tone === "success" ? "var(--ch-whatsapp)" : "var(--accent)";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="text-sm rounded-lg border px-3 py-2.5 break-words"
      style={{ color: "var(--text)", borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {children}
    </div>
  );
}
