// In-memory stand-in for the order_inventory canister (VITE_MOCK=1).

import type { Business, CheckoutInput, Item, Kind, Order } from "./api";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

function tile(emoji: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 42%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><text x="200" y="185" font-size="120" text-anchor="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const business: Business = { name: "Bright Home & Laundry", currency: "NGN" };

let nextId = 1;
const mk = (name: string, kind: Kind, naira: number, description: string, emoji: string, hue: number, stock: number | null, age: number, noImage = false): Item => ({
  id: nextId++, name, kind, description, priceMinor: BigInt(naira * 100), currency: "NGN",
  imageUrl: noImage ? null : tile(emoji, hue), stock, sku: `BHL-${String(nextId).padStart(3, "0")}`, createdAt: Date.now() - age * DAY,
});

const items: Item[] = [
  mk("Wash & Fold (5kg)", "Service", 6500, "Pick-up, wash, dry and fold up to 5kg of laundry. Returned within 24 hours in a sealed bag.", "🧺", 200, null, 40),
  mk("Dry Cleaning - Suit", "Service", 4500, "Two-piece suit professionally dry cleaned, pressed and hung on a hanger with protective cover.", "🧥", 260, null, 38),
  mk("Duvet Cleaning", "Service", 7000, "Deep wash for queen or king duvets, including anti-allergen rinse.", "🛏️", 180, null, 30),
  mk("Express Ironing (10 items)", "Service", 3000, "Same-day ironing for up to ten shirts or trousers.", "👔", 20, null, 25),
  mk("Eco Laundry Detergent 2L", "Product", 5200, "Plant-based liquid detergent, gentle on skin and fabrics. Fragrance-free option.", "🧴", 140, 24, 20),
  mk("Fabric Softener - Lavender 1.5L", "Product", 3400, "Soft, long-lasting lavender scent. Works in all machines.", "💜", 280, 3, 18),
  mk("Stain Remover Spray", "Product", 2200, "Tackles oil, wine and grass stains before washing.", "✨", 50, 40, 15),
  mk("Laundry Basket - Foldable", "Product", 8900, "Collapsible 60L basket with sturdy handles. Folds flat for storage.", "🧺", 330, 12, 12),
  mk("Wooden Clothes Hangers (set of 12)", "Product", 4800, "Smooth-finish hardwood hangers with non-slip trouser bar.", "🪝", 30, 60, 10),
  mk("Steam Iron 2400W", "Product", 24500, "Fast-heat steam iron with ceramic soleplate and anti-drip system.", "♨️", 210, 5, 8),
  mk("Scented Drawer Sachets (6)", "Product", 1800, "Keep wardrobes fresh. Lasts up to 3 months.", "🌸", 340, 0, 6),
  mk("Shoe Cleaning & Restoration", "Service", 5000, "Deep clean and restore leather, suede or canvas shoes.", "👟", 100, null, 5),
  mk("Curtain Cleaning (per panel)", "Service", 3500, "Gentle wash and steam of curtains; take-down and re-hang available.", "🪟", 190, null, 4),
  mk("Garment Steamer Handheld", "Product", 15900, "Portable 1200W steamer, ready in 25 seconds.", "💨", 170, 9, 3, true),
  mk("Mesh Wash Bags (pack of 4)", "Product", 1500, "Protect delicates in the machine. Assorted sizes.", "🛍️", 70, 80, 2),
  mk("Monthly Laundry Plan", "Service", 24000, "Four weekly pick-ups of up to 5kg each, priced for the month.", "📅", 240, null, 1),
];

const orders: Order[] = [];
let orderId = 1040;

export const mock = {
  async loadCatalog() {
    await delay(500);
    return { business, items: items.map((i) => ({ ...i })) };
  },
  async placeOrder(input: CheckoutInput): Promise<Order> {
    await delay(900);
    const lines = input.lines.map((l) => {
      const item = items.find((i) => i.id === l.id);
      if (!item) throw new Error(`inventory item ${l.id} not found`);
      if (item.stock !== null && l.quantity > item.stock) throw new Error(`only ${item.stock} units of ${item.name} are available`);
      return { item, qty: l.quantity };
    });
    for (const { item, qty } of lines) if (item.stock !== null) item.stock -= qty;
    const order: Order = {
      id: orderId++, status: "Pending", createdAt: Date.now(), currency: "NGN",
      totalMinor: lines.reduce((s, { item, qty }) => s + item.priceMinor * BigInt(qty), 0n),
      lines: lines.map(({ item, qty }) => ({ id: item.id, name: item.name, kind: item.kind, quantity: qty, unitMinor: item.priceMinor, totalMinor: item.priceMinor * BigInt(qty) })),
      address: input.address, instructions: input.instructions || null, customerName: input.name || null, customerPhone: input.phone || null, note: input.note || null,
    };
    orders.unshift(order);
    return order;
  },
  async listMyOrders(): Promise<Order[]> {
    await delay(300);
    return orders.map((o) => ({ ...o }));
  },
  async cancelMyOrder(id: number): Promise<Order> {
    await delay(500);
    const o = orders.find((x) => x.id === id);
    if (!o) throw new Error("order not found");
    if (o.status !== "Pending" && o.status !== "AwaitingPayment") throw new Error("only pending orders can be cancelled by customers");
    o.status = "Cancelled";
    for (const l of o.lines) {
      const item = items.find((i) => i.id === l.id);
      if (item && item.stock !== null) item.stock += l.quantity;
    }
    return { ...o };
  },
};

// A couple of past orders so "My orders" isn't empty on first sign-in.
orders.push(
  { id: 1031, status: "Completed", createdAt: Date.now() - 9 * DAY, currency: "NGN", totalMinor: 1_100_000n,
    lines: [{ id: 1, name: "Wash & Fold (5kg)", kind: "Service", quantity: 1, unitMinor: 650_000n, totalMinor: 650_000n }, { id: 5, name: "Eco Laundry Detergent 2L", kind: "Product", quantity: 1, unitMinor: 520_000n, totalMinor: 520_000n }],
    address: "14 Allen Avenue, Ikeja", instructions: null, customerName: "Amaka", customerPhone: null, note: null },
  { id: 1036, status: "OutForDelivery", createdAt: Date.now() - 2 * DAY, currency: "NGN", totalMinor: 450_000n,
    lines: [{ id: 2, name: "Dry Cleaning - Suit", kind: "Service", quantity: 1, unitMinor: 450_000n, totalMinor: 450_000n }],
    address: "14 Allen Avenue, Ikeja", instructions: "Call at the gate", customerName: "Amaka", customerPhone: null, note: null },
);
