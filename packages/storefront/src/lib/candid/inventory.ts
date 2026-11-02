// Hand-written mirror of the storefront-facing part of
// `packages/order_inventory/order_inventory.did`.
//
// EXISTING: list_inventory, get_business.
// NEW (the canister has no customer-facing order path today - only the
// agent-gated `ai_place_order`): place_order, list_my_orders,
// cancel_my_order, and a `Web` variant on the channel. Exact semantics are
// in ../../../README.md ("Backend contract").

import { IDL } from "@icp-sdk/core/candid";

export type InventoryKind = { Product: null } | { Service: null };
export type Channel = { Email: null } | { WhatsApp: null } | { Telegram: null } | { Web: null };

export interface InventoryItem {
  id: bigint;
  sku: [] | [string];
  updated_at: bigint;
  price_minor: bigint;
  active: boolean;
  image_url: [] | [string];
  kind: InventoryKind;
  name: string;
  description: string;
  created_at: bigint;
  currency: string;
  stock_quantity: [] | [bigint];
}

export interface BusinessProfile {
  name: string;
  currency: string;
}

export type OrderStatus =
  | { AwaitingPayment: null } | { Pending: null } | { Confirmed: null } | { Preparing: null } | { Ready: null }
  | { OutForDelivery: null } | { Completed: null } | { Cancelled: null } | { Expired: null };

export interface OrderLine {
  kind: InventoryKind;
  name: string;
  line_total_minor: bigint;
  quantity: bigint;
  inventory_id: bigint;
  unit_price_minor: bigint;
}

export interface DeliveryLocation {
  latitude: [] | [number];
  longitude: [] | [number];
  instructions: [] | [string];
  address: string;
}

export interface Order {
  id: bigint;
  status: OrderStatus;
  created_at: bigint;
  updated_at: bigint;
  customer_name: [] | [string];
  customer_phone: [] | [string];
  note: [] | [string];
  total_minor: bigint;
  currency: string;
  items: OrderLine[];
  delivery_location: DeliveryLocation;
  payment_method: { Prepaid: null } | { CashOnDelivery: null };
}

export interface PlaceOrder {
  items: { inventory_id: bigint; quantity: bigint }[];
  customer_name: [] | [string];
  customer_phone: [] | [string];
  delivery_location: DeliveryLocation;
  note: [] | [string];
  payment_method: [] | [{ Prepaid: null } | { CashOnDelivery: null }];
}

export type OrderError =
  | { Internal: string } | { InvalidInput: string } | { NotFound: string } | { Unauthorized: string } | { Conflict: string };
export type Res<T> = { Ok: T } | { Err: OrderError };

export interface InventoryService {
  list_inventory: () => Promise<InventoryItem[]>;
  get_business: () => Promise<BusinessProfile>;
  /** NEW: any non-anonymous caller. The customer identity is derived from
   * the caller (`{ channel: Web, session_id: caller.to_text() }`). */
  place_order: (input: PlaceOrder) => Promise<Res<Order>>;
  /** NEW: the caller's own orders, newest first. */
  list_my_orders: () => Promise<Res<Order[]>>;
  /** NEW: cancels the caller's own order (same rules as `ai_cancel_my_order`). */
  cancel_my_order: (id: bigint) => Promise<Res<Order>>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Kind = IDL.Variant({ Product: IDL.Null, Service: IDL.Null });
  const Item = IDL.Record({
    id: IDL.Nat64, sku: IDL.Opt(IDL.Text), updated_at: IDL.Nat64, price_minor: IDL.Nat64, active: IDL.Bool,
    image_url: IDL.Opt(IDL.Text), kind: Kind, name: IDL.Text, description: IDL.Text, created_at: IDL.Nat64,
    currency: IDL.Text, stock_quantity: IDL.Opt(IDL.Nat64),
  });
  const Business = IDL.Record({ name: IDL.Text, currency: IDL.Text });
  const Status = IDL.Variant({
    AwaitingPayment: IDL.Null, Pending: IDL.Null, Confirmed: IDL.Null, Preparing: IDL.Null, Ready: IDL.Null,
    OutForDelivery: IDL.Null, Completed: IDL.Null, Cancelled: IDL.Null, Expired: IDL.Null,
  });
  const Line = IDL.Record({
    kind: Kind, name: IDL.Text, line_total_minor: IDL.Nat64, quantity: IDL.Nat64, inventory_id: IDL.Nat64, unit_price_minor: IDL.Nat64,
  });
  const Location = IDL.Record({
    latitude: IDL.Opt(IDL.Float64), longitude: IDL.Opt(IDL.Float64), instructions: IDL.Opt(IDL.Text), address: IDL.Text,
  });
  const Method = IDL.Variant({ Prepaid: IDL.Null, CashOnDelivery: IDL.Null });
  // Decoding ignores record fields this mirror doesn't list, so the many
  // payment/audit fields of the real `Order` are simply skipped.
  const OrderT = IDL.Record({
    id: IDL.Nat64, status: Status, created_at: IDL.Nat64, updated_at: IDL.Nat64,
    customer_name: IDL.Opt(IDL.Text), customer_phone: IDL.Opt(IDL.Text), note: IDL.Opt(IDL.Text),
    total_minor: IDL.Nat64, currency: IDL.Text, items: IDL.Vec(Line), delivery_location: Location, payment_method: Method,
  });
  const PlaceOrderT = IDL.Record({
    items: IDL.Vec(IDL.Record({ inventory_id: IDL.Nat64, quantity: IDL.Nat64 })),
    customer_name: IDL.Opt(IDL.Text), customer_phone: IDL.Opt(IDL.Text), delivery_location: Location,
    note: IDL.Opt(IDL.Text), payment_method: IDL.Opt(Method),
  });
  const Err = IDL.Variant({
    Internal: IDL.Text, InvalidInput: IDL.Text, NotFound: IDL.Text, Unauthorized: IDL.Text, Conflict: IDL.Text,
  });
  const res = <T extends IDL.Type>(t: T) => IDL.Variant({ Ok: t, Err });
  return IDL.Service({
    list_inventory: IDL.Func([], [IDL.Vec(Item)], ["query"]),
    get_business: IDL.Func([], [Business], ["query"]),
    place_order: IDL.Func([PlaceOrderT], [res(OrderT)], []),
    list_my_orders: IDL.Func([], [res(IDL.Vec(OrderT))], ["query"]),
    cancel_my_order: IDL.Func([IDL.Nat64], [res(OrderT)], []),
  });
};
