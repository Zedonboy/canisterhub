import { IDL } from "@icp-sdk/core/candid";

export type PaymentMethod = { Prepaid: null } | { CashOnDelivery: null };
export type Fulfillment = { DineIn: null } | { Takeaway: null } | { Delivery: null };
export type OrderStatus = { AwaitingPayment: null } | { Pending: null } | { Preparing: null } | { Ready: null } | { Served: null } | { OutForDelivery: null } | { Completed: null } | { Cancelled: null };
export type PaymentStatus = { AwaitingPayment: null } | { Paid: null } | { Failed: null } | { CashOnDeliveryPending: null } | { CashOnDeliveryCollected: null };
export type Channel = { WhatsApp: null } | { Telegram: null } | { Email: null } | { Web: null };
export type ConfigVectorValue = { Text: string } | { Boolean: boolean } | { Float: number } | { PrincipalId: import("@icp-sdk/core/principal").Principal } | { Number: bigint };
export type ConfigValue = ConfigVectorValue | { Vector: ConfigVectorValue[] };

export interface MenuItem {
  id: bigint; name: string; description: string; price_per_portion_minor: bigint;
  plate_price_minor: bigint; image_url: [] | [string]; currency: string; payment_method: PaymentMethod;
  available: boolean; created_at: bigint; updated_at: bigint;
}
export interface MenuInput {
  name: string; description: string; price_per_portion_minor: bigint; plate_price_minor: bigint;
  image_url: [] | [string]; currency: string; payment_method: PaymentMethod; available: boolean;
}
export interface MenuUpdate {
  name: [] | [string]; description: [] | [string];
  price_per_portion_minor: [] | [bigint]; plate_price_minor: [] | [bigint];
  image_url: [] | [string]; currency: [] | [string]; payment_method: [] | [PaymentMethod]; available: [] | [boolean];
}
export interface CustomerIdentity { channel: Channel; session_id: string }
export interface OrderLine {
  menu_item_id: bigint; name: string; portions: bigint; price_per_portion_minor: bigint;
  plates: bigint; plate_price_minor: bigint; line_total_minor: bigint;
}
export interface Order {
  id: bigint; customer: CustomerIdentity; agent_canister_id: import("@icp-sdk/core/principal").Principal;
  customer_name: [] | [string]; customer_phone: [] | [string]; customer_email: [] | [string];
  items: OrderLine[]; total_minor: bigint; currency: string; fulfillment: Fulfillment;
  delivery_address: [] | [string]; table_label: [] | [string]; note: [] | [string];
  status: OrderStatus; payment_method: PaymentMethod; payment_status: PaymentStatus;
  merchant_reference: string; checkout_url: [] | [string]; created_at: bigint; updated_at: bigint;
}
export interface PlaceOrderInput {
  items: { menu_item_id: bigint; portions: bigint }[]; fulfillment: Fulfillment;
  delivery_address: [] | [string]; table_label: [] | [string]; customer_name: [] | [string];
  customer_phone: [] | [string]; customer_email: [] | [string]; note: [] | [string];
}
export type Result<T> = { Ok: T } | { Err: string };

export const idlFactory: IDL.InterfaceFactory = ({ IDL: I }) => {
  const AiChannelIDL = I.Variant({ WhatsApp: I.Null, Telegram: I.Null, Email: I.Null, Web: I.Null });
  const PaymentMethodIDL = I.Variant({ Prepaid: I.Null, CashOnDelivery: I.Null });
  const FulfillmentIDL = I.Variant({ DineIn: I.Null, Takeaway: I.Null, Delivery: I.Null });
  const OrderStatusIDL = I.Variant({ AwaitingPayment: I.Null, Pending: I.Null, Preparing: I.Null, Ready: I.Null, Served: I.Null, OutForDelivery: I.Null, Completed: I.Null, Cancelled: I.Null });
  const PaymentStatusIDL = I.Variant({ AwaitingPayment: I.Null, Paid: I.Null, Failed: I.Null, CashOnDeliveryPending: I.Null, CashOnDeliveryCollected: I.Null });
  const ConfigVectorValueIDL = I.Variant({ Text: I.Text, Boolean: I.Bool, Float: I.Float64, PrincipalId: I.Principal, Number: I.Int64 });
  const ConfigValueIDL = I.Variant({ Text: I.Text, Boolean: I.Bool, Float: I.Float64, Vector: I.Vec(ConfigVectorValueIDL), PrincipalId: I.Principal, Number: I.Int64 });
  const MenuItemIDL = I.Record({ id: I.Nat64, name: I.Text, description: I.Text, price_per_portion_minor: I.Nat64, plate_price_minor: I.Nat64, image_url: I.Opt(I.Text), currency: I.Text, payment_method: PaymentMethodIDL, available: I.Bool, created_at: I.Nat64, updated_at: I.Nat64 });
  const MenuInputIDL = I.Record({ name: I.Text, description: I.Text, price_per_portion_minor: I.Nat64, plate_price_minor: I.Nat64, image_url: I.Opt(I.Text), currency: I.Text, payment_method: PaymentMethodIDL, available: I.Bool });
  const MenuUpdateIDL = I.Record({ name: I.Opt(I.Text), description: I.Opt(I.Text), price_per_portion_minor: I.Opt(I.Nat64), plate_price_minor: I.Opt(I.Nat64), image_url: I.Opt(I.Text), currency: I.Opt(I.Text), payment_method: I.Opt(PaymentMethodIDL), available: I.Opt(I.Bool) });
  const CustomerIDL = I.Record({ channel: AiChannelIDL, session_id: I.Text });
  const LineIDL = I.Record({ menu_item_id: I.Nat64, name: I.Text, portions: I.Nat64, price_per_portion_minor: I.Nat64, plates: I.Nat64, plate_price_minor: I.Nat64, line_total_minor: I.Nat64 });
  const OrderIDL = I.Record({ id: I.Nat64, customer: CustomerIDL, agent_canister_id: I.Principal, customer_name: I.Opt(I.Text), customer_phone: I.Opt(I.Text), customer_email: I.Opt(I.Text), items: I.Vec(LineIDL), total_minor: I.Nat64, currency: I.Text, fulfillment: FulfillmentIDL, delivery_address: I.Opt(I.Text), table_label: I.Opt(I.Text), note: I.Opt(I.Text), status: OrderStatusIDL, payment_method: PaymentMethodIDL, payment_status: PaymentStatusIDL, merchant_reference: I.Text, checkout_url: I.Opt(I.Text), created_at: I.Nat64, updated_at: I.Nat64 });
  const PlaceOrderIDL = I.Record({ items: I.Vec(I.Record({ menu_item_id: I.Nat64, portions: I.Nat64 })), fulfillment: FulfillmentIDL, delivery_address: I.Opt(I.Text), table_label: I.Opt(I.Text), customer_name: I.Opt(I.Text), customer_phone: I.Opt(I.Text), customer_email: I.Opt(I.Text), note: I.Opt(I.Text) });
  const result = <T extends IDL.Type>(ok: T) => I.Variant({ Ok: ok, Err: I.Text });
  return I.Service({
    get_config: I.Func([], [I.Vec(I.Tuple(I.Text, ConfigValueIDL))], ["query"]),
    list_menu: I.Func([], [I.Vec(MenuItemIDL)], ["query"]),
    list_all_menu: I.Func([], [result(I.Vec(MenuItemIDL))], ["query"]),
    list_orders: I.Func([I.Opt(OrderStatusIDL)], [result(I.Vec(OrderIDL))], ["query"]),
    create_menu_item: I.Func([MenuInputIDL], [result(MenuItemIDL)], []),
    update_menu_item: I.Func([I.Nat64, MenuUpdateIDL], [result(MenuItemIDL)], []),
    update_order_status: I.Func([I.Nat64, OrderStatusIDL], [result(OrderIDL)], []),
    record_cash_collection: I.Func([I.Nat64, I.Text], [result(OrderIDL)], []),
    web_place_order: I.Func([I.Text, PlaceOrderIDL], [result(OrderIDL)], []),
    web_get_order: I.Func([I.Text, I.Nat64], [I.Opt(OrderIDL)], ["query"]),
  });
};

export interface RestaurantService {
  get_config(): Promise<[string, ConfigValue][]>;
  list_menu(): Promise<MenuItem[]>;
  list_all_menu(): Promise<Result<MenuItem[]>>;
  list_orders(status: [] | [OrderStatus]): Promise<Result<Order[]>>;
  create_menu_item(input: MenuInput): Promise<Result<MenuItem>>;
  update_menu_item(id: bigint, update: MenuUpdate): Promise<Result<MenuItem>>;
  update_order_status(id: bigint, status: OrderStatus): Promise<Result<Order>>;
  record_cash_collection(id: bigint, receipt: string): Promise<Result<Order>>;
  web_place_order(session: string, input: PlaceOrderInput): Promise<Result<Order>>;
  web_get_order(session: string, id: bigint): Promise<[] | [Order]>;
}
