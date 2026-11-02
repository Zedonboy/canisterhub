// UI-facing shapes: candid's `opt` arrays, variants and `nat64`s are
// flattened in `api.ts`, so pages never see `[] | [x]` or `{ Pending: null }`.

export type ItemKind = "Product" | "Service";

export interface InventoryItem {
  id: bigint;
  kind: ItemKind;
  name: string;
  description: string;
  sku: string | null;
  /** Integer minor units (2500 = 25.00 in a two-decimal currency). */
  priceMinor: bigint;
  currency: string;
  /** Public URL of the item's picture (stored on the canister), or `null`. */
  imageUrl: string | null;
  /** `null` means stock isn't tracked for this item (typical for services). */
  stock: bigint | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ItemInput {
  kind: ItemKind;
  name: string;
  description: string;
  sku: string | null;
  priceMinor: bigint;
  currency: string;
  imageUrl: string | null;
  /** `null` = don't track stock. */
  stock: bigint | null;
  active: boolean;
}

/** In the order a healthy order moves through them. */
export const ORDER_STATUSES = ["AwaitingPayment", "Pending", "Confirmed", "Preparing", "Ready", "OutForDelivery", "Completed", "Cancelled", "Expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  AwaitingPayment: "Awaiting payment",
  Pending: "Pending",
  Confirmed: "Confirmed",
  Preparing: "Preparing",
  Ready: "Ready",
  OutForDelivery: "Out for delivery",
  Completed: "Completed",
  Cancelled: "Cancelled",
  Expired: "Expired",
};

/** Mirrors `order_inventory::state::valid_transition` - the canister is the
 * real authority and rejects anything else, this only decides which action
 * buttons to offer. */
export const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  AwaitingPayment: ["Cancelled"],
  Pending: ["Confirmed", "Cancelled"],
  Confirmed: ["Preparing", "Cancelled"],
  Preparing: ["Ready", "Cancelled"],
  Ready: ["OutForDelivery", "Completed", "Cancelled"],
  OutForDelivery: ["Completed"],
  Completed: [],
  Cancelled: [],
  Expired: [],
};

export type PaymentMethod = "Prepaid" | "CashOnDelivery";
export type PaymentStatus = "AwaitingPayment" | "Paid" | "Failed" | "RefundPending" | "PartiallyRefunded" | "Refunded" | "CashOnDeliveryPending" | "CashOnDeliveryCollected" | "Expired";

export interface OrderLine {
  inventoryId: bigint;
  name: string;
  kind: ItemKind;
  quantity: bigint;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
}

export interface Order {
  id: bigint;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  /** e.g. "WhatsApp · +234…" - the conversation the order came in on. */
  channel: string;
  note: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  deliveryCoordinates: { latitude: number; longitude: number } | null;
  currency: string;
  totalMinor: bigint;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  amountPaidMinor: bigint;
  amountRefundedMinor: bigint;
  reservationExpiresAt: number | null;
  lines: OrderLine[];
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry {
  id: bigint;
  orderId: bigint | null;
  actor: string;
  action: string;
  details: string;
  at: number;
}

export interface Business {
  name: string;
  currency: string;
}

/** Orders in these states still need the SME to act. */
export const OPEN_STATUSES: OrderStatus[] = ["AwaitingPayment", "Pending", "Confirmed", "Preparing", "Ready", "OutForDelivery"];

/** The canister has no per-item reorder level, so "low" is one UI-wide
 * threshold. */
export const LOW_STOCK_AT = 5n;

export type StockLevel = "ok" | "low" | "out";

export function stockLevel(item: InventoryItem): StockLevel | null {
  if (item.stock === null) return null;
  if (item.stock === 0n) return "out";
  if (item.stock <= LOW_STOCK_AT) return "low";
  return "ok";
}
