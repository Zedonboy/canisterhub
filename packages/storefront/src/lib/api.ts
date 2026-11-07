// Domain-level wrappers: bigint/opt/variant shapes in, plain objects out.

import { getCustomerActor, getPublicActor } from "./actor";
import type { InventoryItem, Order as RawOrder, OrderError, Res } from "./candid/inventory";
import { mock } from "./mock";

const MOCK = import.meta.env.VITE_MOCK === "1";

export type Kind = "Product" | "Service";
export type PaymentMethod = "Prepaid" | "CashOnDelivery";
export type OrderStatus = "AwaitingPayment" | "Pending" | "Confirmed" | "Preparing" | "Ready" | "OutForDelivery" | "Completed" | "Cancelled" | "Expired";

export interface Item {
  id: number;
  name: string;
  description: string;
  kind: Kind;
  priceMinor: bigint;
  currency: string;
  imageUrl: string | null;
  /** `null` = stock isn't tracked (always available). */
  stock: number | null;
  sku: string | null;
  createdAt: number;
  paymentMethod: PaymentMethod;
}

export interface Order {
  id: number;
  status: OrderStatus;
  createdAt: number;
  totalMinor: bigint;
  currency: string;
  lines: { id: number; name: string; kind: Kind; quantity: number; unitMinor: bigint; totalMinor: bigint }[];
  address: string;
  instructions: string | null;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
  checkoutUrl: string | null;
}

export interface Business {
  name: string;
  currency: string;
}

export interface CheckoutInput {
  lines: { id: number; quantity: number }[];
  name: string;
  phone: string;
  email: string;
  address: string;
  instructions: string;
  note: string;
}

const ms = (ns: bigint) => Number(ns / 1_000_000n);
const opt = <T,>(v: [] | [T]): T | null => (v.length ? v[0] : null);
const optText = (s: string): [] | [string] => (s.trim() ? [s.trim()] : []);

function toItem(i: InventoryItem): Item {
  const stock = opt(i.stock_quantity);
  return {
    id: Number(i.id), name: i.name, description: i.description, kind: "Product" in i.kind ? "Product" : "Service",
    priceMinor: i.price_minor, currency: i.currency, imageUrl: opt(i.image_url), stock: stock === null ? null : Number(stock),
    sku: opt(i.sku), createdAt: ms(i.created_at),
    paymentMethod: "Prepaid" in i.payment_method ? "Prepaid" : "CashOnDelivery",
  };
}

function toOrder(o: RawOrder): Order {
  return {
    id: Number(o.id), status: Object.keys(o.status)[0] as OrderStatus, createdAt: ms(o.created_at),
    totalMinor: o.total_minor, currency: o.currency,
    lines: o.items.map((l) => ({
      id: Number(l.inventory_id), name: l.name, kind: "Product" in l.kind ? "Product" : "Service",
      quantity: Number(l.quantity), unitMinor: l.unit_price_minor, totalMinor: l.line_total_minor,
    })),
    address: o.delivery_location.address, instructions: opt(o.delivery_location.instructions),
    customerName: opt(o.customer_name), customerPhone: opt(o.customer_phone), note: opt(o.note),
    checkoutUrl: opt(o.checkout_url),
  };
}

function errMsg(e: OrderError): string {
  return Object.values(e)[0] as string;
}

function unwrap<T>(r: Res<T>): T {
  if ("Err" in r) throw new Error(errMsg(r.Err));
  return r.Ok;
}

export async function loadCatalog(): Promise<{ business: Business; items: Item[] }> {
  if (MOCK) return mock.loadCatalog();
  const actor = await getPublicActor();
  const [business, items] = await Promise.all([actor.get_business(), actor.list_inventory()]);
  return { business, items: items.map(toItem) };
}

export async function placeOrder(input: CheckoutInput): Promise<Order> {
  if (MOCK) return mock.placeOrder(input);
  const actor = await getCustomerActor();
  return toOrder(
    unwrap(
      await actor.place_order({
        items: input.lines.map((l) => ({ inventory_id: BigInt(l.id), quantity: BigInt(l.quantity) })),
        customer_name: optText(input.name),
        customer_phone: optText(input.phone),
        customer_email: optText(input.email),
        delivery_location: { address: input.address.trim(), instructions: optText(input.instructions), latitude: [], longitude: [] },
        note: optText(input.note),
      }),
    ),
  );
}

export async function listMyOrders(): Promise<Order[]> {
  if (MOCK) return mock.listMyOrders();
  const actor = await getCustomerActor();
  return unwrap(await actor.list_my_orders()).map(toOrder);
}

export async function cancelMyOrder(id: number): Promise<Order> {
  if (MOCK) return mock.cancelMyOrder(id);
  const actor = await getCustomerActor();
  return toOrder(unwrap(await actor.cancel_my_order(BigInt(id))));
}
