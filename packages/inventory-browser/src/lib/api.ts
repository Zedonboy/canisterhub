// The only place that talks to `order_inventory`: converts candid's `opt`
// arrays, variants and `nat64`s to the plain shapes in `types.ts`, and
// canister `Err` results to thrown `Error`s with the canister's own message.
// Every admin method is controller-only, so a caller that isn't one gets
// `UnauthorizedError` - `App.tsx` turns that into a sign-in prompt.

import { getInventoryActor } from "./actor";
import { withSession } from "./session";
import type * as C from "./candid/orderInventory";
import type { AuditEntry, Business, InventoryItem, ItemInput, ItemKind, Order, OrderLine, OrderStatus, PaymentMethod } from "./types";

export class UnauthorizedError extends Error {}

function unwrap<T>(result: C.Result<T>): T {
  if ("Ok" in result) return result.Ok;
  const [kind, message] = Object.entries(result.Err)[0] as [string, string];
  throw kind === "Unauthorized" ? new UnauthorizedError(message) : new Error(message);
}

const opt = <T>(v: [] | [T]): T | null => (v.length ? v[0] : null);
const some = <T>(v: T): [T] => [v];
const none: [] = [];
const toOpt = <T>(v: T | null): [] | [T] => (v === null ? none : some(v));
/** nanoseconds since epoch -> ms. */
const nsToMs = (ns: bigint) => Number(ns / 1_000_000n);
const variantKey = <K extends string>(v: object): K => Object.keys(v)[0] as K;

const kindOut = (k: ItemKind): C.InventoryKind => (k === "Product" ? { Product: null } : { Service: null });
const paymentMethodOut = (method: PaymentMethod): C.PaymentMethod =>
  method === "Prepaid" ? { Prepaid: null } : { CashOnDelivery: null };

function itemIn(i: C.InventoryItem): InventoryItem {
  return {
    id: i.id,
    kind: variantKey(i.kind),
    name: i.name,
    description: i.description,
    sku: opt(i.sku),
    priceMinor: i.price_minor,
    currency: i.currency,
    paymentMethod: variantKey(i.payment_method),
    imageUrl: opt(i.image_url),
    stock: opt(i.stock_quantity),
    active: i.active,
    createdAt: nsToMs(i.created_at),
    updatedAt: nsToMs(i.updated_at),
  };
}

function lineIn(l: C.OrderLine): OrderLine {
  return {
    inventoryId: l.inventory_id,
    name: l.name,
    sku: opt(l.sku),
    kind: variantKey(l.kind),
    quantity: l.quantity,
    unitPriceMinor: l.unit_price_minor,
    lineTotalMinor: l.line_total_minor,
  };
}

function orderIn(o: C.Order): Order {
  const location = o.delivery_location;
  const lat = opt(location.latitude);
  const lon = opt(location.longitude);
  return {
    id: o.id,
    status: variantKey(o.status),
    customerName: opt(o.customer_name),
    customerPhone: opt(o.customer_phone),
    channel: `${variantKey(o.customer.channel)} · ${o.customer.session_id}`,
    note: opt(o.note),
    deliveryAddress: location.address || null,
    deliveryInstructions: opt(location.instructions),
    deliveryCoordinates: lat !== null && lon !== null ? { latitude: lat, longitude: lon } : null,
    currency: o.currency,
    totalMinor: o.total_minor,
    paymentMethod: variantKey(o.payment_method),
    paymentStatus: variantKey(o.payment_status),
    paymentReference: opt(o.payment_reference),
    checkoutUrl: opt(o.checkout_url),
    amountPaidMinor: o.amount_paid_minor,
    amountRefundedMinor: o.amount_refunded_minor,
    reservationExpiresAt: opt(o.reservation_expires_at) === null ? null : nsToMs(opt(o.reservation_expires_at)!),
    lines: o.items.map(lineIn),
    createdAt: nsToMs(o.created_at),
    updatedAt: nsToMs(o.updated_at),
  };
}

function auditIn(entry: C.AuditEntry): AuditEntry {
  return {
    id: entry.id,
    orderId: opt(entry.order_id),
    actor: entry.actor,
    action: entry.action,
    details: entry.details,
    at: nsToMs(entry.at),
  };
}

/** One canister call as the current identity, renewed-and-retried once if the
 * dashboard delegation turns out to have expired. */
const call = <T>(fn: (actor: Awaited<ReturnType<typeof getInventoryActor>>) => Promise<T>): Promise<T> =>
  withSession(async () => fn(await getInventoryActor()));

export const inventoryApi = {
  async getBusiness(): Promise<Business> {
    return call((a) => a.get_business());
  },

  async setBusiness(business: Business): Promise<Business> {
    return unwrap(await call((a) => a.set_business(business)));
  },

  async listItems(): Promise<InventoryItem[]> {
    return unwrap(await call((a) => a.list_all_inventory())).map(itemIn);
  },

  async createItem(input: ItemInput): Promise<InventoryItem> {
    const created = unwrap(
      await call((a) => a.create_inventory({
        kind: kindOut(input.kind),
        name: input.name.trim(),
        description: input.description.trim(),
        sku: toOpt(input.sku?.trim() || null),
        price_minor: input.priceMinor,
        currency: input.currency.trim(),
        payment_method: some(paymentMethodOut(input.paymentMethod)),
        image_url: toOpt(input.imageUrl),
        stock_quantity: toOpt(input.stock),
      }))
    );
    // `create_inventory` has no `active` field - new items are always active,
    // so an inactive one needs a follow-up update.
    return input.active ? itemIn(created) : this.updateItem(created.id, { active: false });
  },

  /** Only the fields present in `patch` change. `stock: null` stops tracking
   * stock; a number starts/keeps tracking and sets the quantity.
   * `imageUrl: null` removes the image, a string sets it. */
  async updateItem(id: bigint, patch: Partial<ItemInput>): Promise<InventoryItem> {
    const stockPatch =
      patch.stock === undefined
        ? { track_stock: none, stock_quantity: none }
        : patch.stock === null
          ? { track_stock: some(false), stock_quantity: none }
          : { track_stock: some(true), stock_quantity: some(patch.stock) };
    const update: C.UpdateInventoryItem = {
      kind: patch.kind === undefined ? none : some(kindOut(patch.kind)),
      name: patch.name === undefined ? none : some(patch.name.trim()),
      description: patch.description === undefined ? none : some(patch.description.trim()),
      // the canister can't clear a SKU, only set one
      sku: patch.sku ? some(patch.sku.trim()) : none,
      price_minor: patch.priceMinor === undefined ? none : some(patch.priceMinor),
      currency: patch.currency === undefined ? none : some(patch.currency.trim()),
      payment_method: patch.paymentMethod === undefined ? none : some(paymentMethodOut(patch.paymentMethod)),
      // the canister clears an image when given an empty string
      image_url: patch.imageUrl === undefined ? none : some(patch.imageUrl ?? ""),
      active: patch.active === undefined ? none : some(patch.active),
      ...stockPatch,
    };
    return itemIn(unwrap(await call((a) => a.update_inventory(id, update))));
  },

  async listOrders(): Promise<Order[]> {
    const orders = unwrap(await call((a) => a.list_orders(none))).map(orderIn);
    return orders.sort((a, b) => b.createdAt - a.createdAt);
  },

  async setOrderStatus(id: bigint, status: OrderStatus): Promise<Order> {
    return orderIn(unwrap(await call((a) => a.update_order_status(id, { [status]: null } as C.OrderStatus))));
  },
  async listAudit(orderId: bigint): Promise<AuditEntry[]> {
    return unwrap(await call((a) => a.list_audit([orderId], 0n, 200n))).map(auditIn);
  },
  async recordCashCollection(order: Order, receiptReference: string): Promise<Order> {
    return orderIn(unwrap(await call((a) => a.record_cash_collection({
      order_id: order.id,
      receipt_reference: receiptReference,
      amount_minor: order.totalMinor,
      currency: order.currency,
    }))));
  },
  async recordRefund(order: Order, provider: string, transactionId: string): Promise<Order> {
    const amount = order.amountPaidMinor - order.amountRefundedMinor;
    return orderIn(unwrap(await call((a) => a.record_refund({
      order_id: order.id,
      provider,
      transaction_id: transactionId,
      amount_minor: amount,
    }))));
  },
};
