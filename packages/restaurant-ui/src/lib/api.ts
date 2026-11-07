import { getAnonymousRestaurantActor, getRestaurantActor } from "./actor";
import { withSession } from "./session";
import type * as C from "./candid/restaurant";

export type MenuItem = C.MenuItem;
export type Order = C.Order;
export type MenuInput = C.MenuInput;
export type PlaceOrderInput = C.PlaceOrderInput;

function unwrap<T>(result: C.Result<T>): T {
  if ("Ok" in result) return result.Ok;
  throw new Error(result.Err);
}
const some = <T>(value: T): [T] => [value];
const none: [] = [];
const opt = <T>(value: T | null): [] | [T] => value === null ? none : some(value);
const variant = <T extends string>(name: T) => ({ [name]: null }) as Record<T, null>;

export type OrderState = "AwaitingPayment" | "Pending" | "Preparing" | "Ready" | "Served" | "OutForDelivery" | "Completed" | "Cancelled";
export type FoodFulfillment = "DineIn" | "Takeaway" | "Delivery";
export type FoodPayment = "Prepaid" | "CashOnDelivery";

export const restaurantApi = {
  listPublicMenu: async () => (await getAnonymousRestaurantActor()).list_menu(),
  listMenu: () => withSession(async () => unwrap(await (await getRestaurantActor()).list_all_menu())),
  listOrders: () => withSession(async () => unwrap(await (await getRestaurantActor()).list_orders([]))),
  createMenuItem: (input: MenuInput) => withSession(async () => unwrap(await (await getRestaurantActor()).create_menu_item(input))),
  updateMenuItem: (id: bigint, patch: Partial<MenuInput>) => withSession(async () => {
    const update: C.MenuUpdate = {
      name: patch.name === undefined ? none : some(patch.name),
      description: patch.description === undefined ? none : some(patch.description),
      price_per_portion_minor: patch.price_per_portion_minor === undefined ? none : some(patch.price_per_portion_minor),
      plate_price_minor: patch.plate_price_minor === undefined ? none : some(patch.plate_price_minor),
      image_url: patch.image_url === undefined ? none : some(patch.image_url[0] ?? ""),
      currency: patch.currency === undefined ? none : some(patch.currency),
      payment_method: patch.payment_method === undefined ? none : some(patch.payment_method),
      available: patch.available === undefined ? none : some(patch.available),
    };
    return unwrap(await (await getRestaurantActor()).update_menu_item(id, update));
  }),
  updateOrderStatus: (id: bigint, status: OrderState) => withSession(async () => unwrap(await (await getRestaurantActor()).update_order_status(id, variant(status) as C.OrderStatus))),
  recordCashCollection: (id: bigint, reference: string) => withSession(async () => unwrap(await (await getRestaurantActor()).record_cash_collection(id, reference))),
  placeWebOrder: (session: string, input: PlaceOrderInput) => getAnonymousRestaurantActor().then((actor) => actor.web_place_order(session, input)).then(unwrap),
  getWebOrder: async (session: string, id: bigint) => {
    const order = await (await getAnonymousRestaurantActor()).web_get_order(session, id);
    return order.length ? order[0] : null;
  },
};

export const optional = opt;
export const paymentVariant = (value: FoodPayment): C.PaymentMethod => variant(value) as C.PaymentMethod;
export const fulfillmentVariant = (value: FoodFulfillment): C.Fulfillment => variant(value) as C.Fulfillment;
