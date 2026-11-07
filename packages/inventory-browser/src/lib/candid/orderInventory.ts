// Hand-written mirror of `packages/order_inventory/order_inventory.did` -
// only the methods this UI calls (the controller-only admin surface; the
// `ai_*` methods belong to the agent canister, not to a browser). Same
// convention as `packages/table-browser/src/lib/candid/icSql.ts`.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export type InventoryKind = { Product: null } | { Service: null };

export type OrderStatus =
  | { AwaitingPayment: null }
  | { Pending: null }
  | { Confirmed: null }
  | { Preparing: null }
  | { Ready: null }
  | { OutForDelivery: null }
  | { Completed: null }
  | { Cancelled: null }
  | { Expired: null };

export type PaymentMethod = { Prepaid: null } | { CashOnDelivery: null };
export type PaymentStatus =
  | { AwaitingPayment: null }
  | { Paid: null }
  | { Failed: null }
  | { RefundPending: null }
  | { PartiallyRefunded: null }
  | { Refunded: null }
  | { CashOnDeliveryPending: null }
  | { CashOnDeliveryCollected: null }
  | { Expired: null };

export type AiChannel = { WhatsApp: null } | { Telegram: null } | { Email: null } | { Web: null };

export type OrderError =
  | { Internal: string }
  | { InvalidInput: string }
  | { NotFound: string }
  | { Unauthorized: string }
  | { Conflict: string };

export interface InventoryItem {
  id: bigint;
  sku: [] | [string];
  updated_at: bigint;
  price_minor: bigint;
  active: boolean;
  kind: InventoryKind;
  name: string;
  description: string;
  created_at: bigint;
  currency: string;
  image_url: [] | [string];
  stock_quantity: [] | [bigint];
  payment_method: PaymentMethod;
}

export interface CreateInventoryItem {
  sku: [] | [string];
  price_minor: bigint;
  kind: InventoryKind;
  name: string;
  description: string;
  currency: string;
  image_url: [] | [string];
  stock_quantity: [] | [bigint];
  payment_method: [] | [PaymentMethod];
}

export interface UpdateInventoryItem {
  sku: [] | [string];
  price_minor: [] | [bigint];
  active: [] | [boolean];
  kind: [] | [InventoryKind];
  name: [] | [string];
  description: [] | [string];
  currency: [] | [string];
  /** An empty string removes the image. */
  image_url: [] | [string];
  stock_quantity: [] | [bigint];
  track_stock: [] | [boolean];
  payment_method: [] | [PaymentMethod];
}

export interface OrderLine {
  kind: InventoryKind;
  name: string;
  sku: [] | [string];
  line_total_minor: bigint;
  quantity: bigint;
  inventory_id: bigint;
  unit_price_minor: bigint;
}

export interface DeliveryLocation {
  latitude: [] | [number];
  instructions: [] | [string];
  longitude: [] | [number];
  address: string;
}

export interface Order {
  id: bigint;
  status: OrderStatus;
  updated_at: bigint;
  customer_phone: [] | [string];
  customer_email: [] | [string];
  customer: { session_id: string; channel: AiChannel };
  agent_canister_id: [] | [Principal];
  note: [] | [string];
  created_at: bigint;
  total_minor: bigint;
  currency: string;
  items: OrderLine[];
  customer_name: [] | [string];
  delivery_location: DeliveryLocation;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  payment_reference: [] | [string];
  checkout_url: [] | [string];
  amount_paid_minor: bigint;
  amount_refunded_minor: bigint;
  reservation_expires_at: [] | [bigint];
  stock_released: boolean;
}

export interface BusinessProfile {
  name: string;
  currency: string;
}

export interface AuditEntry {
  id: bigint;
  order_id: [] | [bigint];
  actor: string;
  action: string;
  details: string;
  at: bigint;
}

export interface RecordCashCollection {
  order_id: bigint;
  receipt_reference: string;
  amount_minor: bigint;
  currency: string;
}

export interface RecordRefund {
  order_id: bigint;
  provider: string;
  transaction_id: string;
  amount_minor: bigint;
}

/** `ic::config`'s wire value (see `packages/order_inventory/order_inventory.did`). */
export type ConfigVectorValue = { Text: string } | { Boolean: boolean } | { Float: number } | { PrincipalId: Principal } | { Number: bigint };
export type ConfigValue = ConfigVectorValue | { Vector: ConfigVectorValue[] };

export type Result<T> = { Ok: T } | { Err: OrderError };

export interface OrderInventoryService {
  get_business: () => Promise<BusinessProfile>;
  get_config: () => Promise<Array<[string, ConfigValue]>>;
  set_business: (profile: BusinessProfile) => Promise<Result<BusinessProfile>>;
  list_all_inventory: () => Promise<Result<InventoryItem[]>>;
  create_inventory: (input: CreateInventoryItem) => Promise<Result<InventoryItem>>;
  update_inventory: (id: bigint, input: UpdateInventoryItem) => Promise<Result<InventoryItem>>;
  list_orders: (status: [] | [OrderStatus]) => Promise<Result<Order[]>>;
  update_order_status: (id: bigint, status: OrderStatus) => Promise<Result<Order>>;
  list_audit: (orderId: [] | [bigint], offset: bigint, limit: bigint) => Promise<Result<AuditEntry[]>>;
  record_cash_collection: (input: RecordCashCollection) => Promise<Result<Order>>;
  record_refund: (input: RecordRefund) => Promise<Result<Order>>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const InventoryKind = IDL.Variant({ Product: IDL.Null, Service: IDL.Null });
  const OrderStatus = IDL.Variant({
    AwaitingPayment: IDL.Null,
    Confirmed: IDL.Null,
    Ready: IDL.Null,
    Preparing: IDL.Null,
    Cancelled: IDL.Null,
    OutForDelivery: IDL.Null,
    Completed: IDL.Null,
    Pending: IDL.Null,
    Expired: IDL.Null,
  });
  const PaymentMethod = IDL.Variant({ Prepaid: IDL.Null, CashOnDelivery: IDL.Null });
  const PaymentStatus = IDL.Variant({
    Failed: IDL.Null,
    Refunded: IDL.Null,
    Paid: IDL.Null,
    AwaitingPayment: IDL.Null,
    CashOnDeliveryCollected: IDL.Null,
    RefundPending: IDL.Null,
    CashOnDeliveryPending: IDL.Null,
    PartiallyRefunded: IDL.Null,
    Expired: IDL.Null,
  });
  const AiChannel = IDL.Variant({ Email: IDL.Null, WhatsApp: IDL.Null, Telegram: IDL.Null, Web: IDL.Null });
  const OrderError = IDL.Variant({
    Internal: IDL.Text,
    InvalidInput: IDL.Text,
    NotFound: IDL.Text,
    Unauthorized: IDL.Text,
    Conflict: IDL.Text,
  });
  const BusinessProfile = IDL.Record({ name: IDL.Text, currency: IDL.Text });
  const InventoryItem = IDL.Record({
    id: IDL.Nat64,
    sku: IDL.Opt(IDL.Text),
    updated_at: IDL.Nat64,
    price_minor: IDL.Nat64,
    active: IDL.Bool,
    kind: InventoryKind,
    name: IDL.Text,
    description: IDL.Text,
    created_at: IDL.Nat64,
    currency: IDL.Text,
    image_url: IDL.Opt(IDL.Text),
    stock_quantity: IDL.Opt(IDL.Nat64),
    payment_method: PaymentMethod,
  });
  const CreateInventoryItem = IDL.Record({
    sku: IDL.Opt(IDL.Text),
    price_minor: IDL.Nat64,
    kind: InventoryKind,
    name: IDL.Text,
    description: IDL.Text,
    currency: IDL.Text,
    image_url: IDL.Opt(IDL.Text),
    stock_quantity: IDL.Opt(IDL.Nat64),
    payment_method: IDL.Opt(PaymentMethod),
  });
  const UpdateInventoryItem = IDL.Record({
    sku: IDL.Opt(IDL.Text),
    price_minor: IDL.Opt(IDL.Nat64),
    active: IDL.Opt(IDL.Bool),
    kind: IDL.Opt(InventoryKind),
    name: IDL.Opt(IDL.Text),
    description: IDL.Opt(IDL.Text),
    currency: IDL.Opt(IDL.Text),
    image_url: IDL.Opt(IDL.Text),
    stock_quantity: IDL.Opt(IDL.Nat64),
    track_stock: IDL.Opt(IDL.Bool),
    payment_method: IDL.Opt(PaymentMethod),
  });
  const OrderLine = IDL.Record({
    kind: InventoryKind,
    name: IDL.Text,
    sku: IDL.Opt(IDL.Text),
    line_total_minor: IDL.Nat64,
    quantity: IDL.Nat64,
    inventory_id: IDL.Nat64,
    unit_price_minor: IDL.Nat64,
  });
  const DeliveryLocation = IDL.Record({
    latitude: IDL.Opt(IDL.Float64),
    instructions: IDL.Opt(IDL.Text),
    longitude: IDL.Opt(IDL.Float64),
    address: IDL.Text,
  });
  const CustomerIdentity = IDL.Record({ session_id: IDL.Text, channel: AiChannel });
  const Order = IDL.Record({
    id: IDL.Nat64,
    status: OrderStatus,
    updated_at: IDL.Nat64,
    customer_phone: IDL.Opt(IDL.Text),
    customer: CustomerIdentity,
    agent_canister_id: IDL.Opt(IDL.Principal),
    note: IDL.Opt(IDL.Text),
    created_at: IDL.Nat64,
    total_minor: IDL.Nat64,
    currency: IDL.Text,
    items: IDL.Vec(OrderLine),
    customer_name: IDL.Opt(IDL.Text),
    delivery_location: DeliveryLocation,
    payment_method: PaymentMethod,
    payment_status: PaymentStatus,
    payment_reference: IDL.Opt(IDL.Text), checkout_url: IDL.Opt(IDL.Text), customer_email: IDL.Opt(IDL.Text),
    amount_paid_minor: IDL.Nat64,
    amount_refunded_minor: IDL.Nat64,
    reservation_expires_at: IDL.Opt(IDL.Nat64),
    stock_released: IDL.Bool,
  });
  const AuditEntry = IDL.Record({
    at: IDL.Nat64,
    id: IDL.Nat64,
    action: IDL.Text,
    actor: IDL.Text,
    details: IDL.Text,
    order_id: IDL.Opt(IDL.Nat64),
  });
  const RecordCashCollection = IDL.Record({
    amount_minor: IDL.Nat64,
    currency: IDL.Text,
    order_id: IDL.Nat64,
    receipt_reference: IDL.Text,
  });
  const RecordRefund = IDL.Record({
    amount_minor: IDL.Nat64,
    transaction_id: IDL.Text,
    provider: IDL.Text,
    order_id: IDL.Nat64,
  });
  const ConfigVectorValue = IDL.Variant({ Text: IDL.Text, Boolean: IDL.Bool, Float: IDL.Float64, PrincipalId: IDL.Principal, Number: IDL.Int64 });
  const ConfigValue = IDL.Variant({ Text: IDL.Text, Boolean: IDL.Bool, Float: IDL.Float64, PrincipalId: IDL.Principal, Number: IDL.Int64, Vector: IDL.Vec(ConfigVectorValue) });
  const result = <T extends IDL.Type>(ok: T) => IDL.Variant({ Ok: ok, Err: OrderError });

  return IDL.Service({
    get_business: IDL.Func([], [BusinessProfile], ["query"]),
    get_config: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, ConfigValue))], ["query"]),
    set_business: IDL.Func([BusinessProfile], [result(BusinessProfile)], []),
    list_all_inventory: IDL.Func([], [result(IDL.Vec(InventoryItem))], ["query"]),
    create_inventory: IDL.Func([CreateInventoryItem], [result(InventoryItem)], []),
    update_inventory: IDL.Func([IDL.Nat64, UpdateInventoryItem], [result(InventoryItem)], []),
    list_orders: IDL.Func([IDL.Opt(OrderStatus)], [result(IDL.Vec(Order))], ["query"]),
    update_order_status: IDL.Func([IDL.Nat64, OrderStatus], [result(Order)], []),
    list_audit: IDL.Func([IDL.Opt(IDL.Nat64), IDL.Nat64, IDL.Nat64], [result(IDL.Vec(AuditEntry))], ["query"]),
    record_cash_collection: IDL.Func([RecordCashCollection], [result(Order)], []),
    record_refund: IDL.Func([RecordRefund], [result(Order)], []),
  });
};
