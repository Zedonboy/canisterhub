import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Minus, Plus, Search, ShoppingBag, UtensilsCrossed } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field, Select } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { restaurantApi, fulfillmentVariant, optional, type FoodFulfillment, type MenuItem, type Order } from "@/lib/api";
import type * as C from "@/lib/candid/restaurant";
import { formatMoney } from "@/lib/format";

const key = (variant: object) => Object.keys(variant)[0];
type CartPlate = { key: number; item: MenuItem; portions: number };
const sessionId = () => {
  const storageKey = "restaurant-web-session";
  let id = localStorage.getItem(storageKey);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(storageKey, id); }
  return id;
};

export default function StorefrontPage() {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartPlate[]>([]);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [portionItem, setPortionItem] = useState<MenuItem | null>(null);
  const [portionCount, setPortionCount] = useState("1");
  const [checkout, setCheckout] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<FoodFulfillment>("Takeaway");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [table, setTable] = useState("");
  const [note, setNote] = useState("");

  const reload = async () => {
    try { setMenu(await restaurantApi.listPublicMenu()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!placedOrder || ["Paid", "Failed", "CashOnDeliveryCollected"].includes(key(placedOrder.payment_status)) || ["Completed", "Cancelled"].includes(key(placedOrder.status))) return;
    const timer = window.setInterval(async () => {
      try {
        const latest = await restaurantApi.getWebOrder(sessionId(), placedOrder.id);
        if (latest) setPlacedOrder(latest);
      } catch { /* Keep showing the last known order state until the next poll. */ }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [placedOrder?.id, placedOrder?.payment_status]);

  const visible = useMemo(() => menu.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())), [menu, query]);
  const currency = cart[0]?.item.currency ?? menu[0]?.currency ?? "NGN";
  const total = cart.reduce((sum, plate) => sum + plate.item.price_per_portion_minor * BigInt(plate.portions) + plate.item.plate_price_minor, 0n);
  const paymentType = cart[0] ? key(cart[0].item.payment_method) : "CashOnDelivery";
  const count = cart.length;
  const compatible = (item: MenuItem) => !cart.length || (item.currency === currency && key(item.payment_method) === paymentType);
  const changePlatePortions = (plateKey: number, delta: number) => setCart((old) => old.flatMap((plate) => {
    if (plate.key !== plateKey) return [plate];
    const portions = plate.portions + delta;
    return portions > 0 ? [{ ...plate, portions }] : [];
  }));
  const openPortionDialog = (item: MenuItem) => {
    setSelectedItem(null);
    setPortionItem(item);
    setPortionCount("1");
  };
  const addPlate = () => {
    const portions = Number(portionCount);
    if (!Number.isSafeInteger(portions) || portions < 1 || portions > 100) return;
    if (!portionItem || !compatible(portionItem)) return;
    setCart((old) => [...old, { key: Date.now() + Math.random(), item: portionItem, portions }]);
    setPortionItem(null);
  };

  const submitOrder = async () => {
    if (!cart.length) return;
    if (fulfillment === "Delivery" && !address.trim()) return setSubmitError("Enter your delivery address.");
    if (fulfillment === "DineIn" && !table.trim()) return setSubmitError("Enter your table number or label.");
    if (paymentType === "Prepaid" && !email.trim()) return setSubmitError("Email is required for prepaid checkout.");
    setBusy(true); setSubmitError(null);
    const input: C.PlaceOrderInput = {
      items: cart.map((plate) => ({ menu_item_id: plate.item.id, portions: BigInt(plate.portions) })),
      fulfillment: fulfillmentVariant(fulfillment), delivery_address: optional(fulfillment === "Delivery" ? address.trim() : null),
      table_label: optional(fulfillment === "DineIn" ? table.trim() : null), customer_name: optional(name.trim() || null),
      customer_phone: optional(phone.trim() || null), customer_email: optional(email.trim() || null), note: optional(note.trim() || null),
    };
    try {
      const order = await restaurantApi.placeWebOrder(sessionId(), input);
      setPlacedOrder(order); setCheckout(false); setCart([]);
    } catch (e) { setSubmitError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="min-h-full bg-[#0a0e1a] text-[#e2e8f0]">
    <header className="sticky top-0 z-20 border-b border-[#1e2d47] bg-[#0a0e1a]/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00d4ff18] text-[#00d4ff]"><UtensilsCrossed size={18} /></div>
        <div><h1 className="text-sm font-semibold">Restaurant Menu</h1><p className="text-[11px] text-[#4a5568]">Order fresh food directly from the kitchen</p></div>
        <Button className="ml-auto" variant="primary" onClick={() => setCheckout(true)} disabled={!count}><ShoppingBag size={14} /> Cart{count > 0 && <span className="ml-1 rounded-full bg-[#0a0e1a] px-1.5 text-[10px] text-[#00d4ff]">{count}</span>}</Button>
      </div>
    </header>
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="rounded-2xl border border-[#1e2d47] bg-gradient-to-br from-[#101a2c] to-[#0d1526] p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#00d4ff]">Made to order</p><h2 className="mt-2 text-2xl font-semibold sm:text-3xl">What are you craving?</h2>
        <p className="mt-2 max-w-xl text-sm text-[#8892a4]">Choose a dish, then set how many portions go on each plate. Each plate is added and charged separately.</p>
        <div className="relative mt-5 max-w-md"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a5568]" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the menu" className="pl-9" /></div>
      </div>
      {error && <div className="rounded-lg border border-[#ff525244] bg-[#ff525211] p-4 text-sm text-[#ff8b8b]">Couldn't load the menu: {error} <button onClick={() => void reload()} className="ml-2 underline">Try again</button></div>}
      {loading ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-52 animate-pulse rounded-xl border border-[#1e2d47] bg-[#0d1526]" />)}</div> : visible.length === 0 ? <div className="py-16 text-center text-sm text-[#8892a4]">{menu.length ? "No dishes match your search." : "The menu is not available yet. Please check back soon."}</div> : <>
        <p className="text-xs text-[#4a5568]">{visible.length} {visible.length === 1 ? "dish" : "dishes"}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((item) => {
            return <article key={item.id.toString()} className="group flex flex-col overflow-hidden rounded-xl border border-[#1e2d47] bg-[#0d1526] transition-all hover:-translate-y-0.5 hover:border-[#00d4ff66] hover:shadow-xl hover:shadow-black/20">
              <div className="flex aspect-[16/10] items-center justify-center overflow-hidden bg-gradient-to-br from-[#16243b] via-[#101a2c] to-[#0d1526] text-[#00d4ff55]">{item.image_url[0] ? <img src={item.image_url[0]} alt={item.name} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" /> : <UtensilsCrossed size={38} strokeWidth={1.3} />}</div>
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-start justify-between gap-2"><h3 className="font-semibold leading-snug">{item.name}</h3><Badge variant={"Prepaid" in item.payment_method ? "cyan" : "gray"}>{"Prepaid" in item.payment_method ? "prepaid" : "pay at pickup"}</Badge></div>
                <p className="mt-2 min-h-10 text-xs leading-5 text-[#8892a4] line-clamp-2">{item.description || "Freshly prepared when you order."}</p>
                <p className="mt-4 text-[11px] text-[#8892a4]">per portion <span className="ml-1 text-[10px] text-[#4a5568]">+ plate {formatMoney(item.plate_price_minor, item.currency)}</span></p>
                <div className="mt-auto flex items-center justify-between gap-2 pt-2"><span className="text-lg font-semibold tabular-nums">{formatMoney(item.price_per_portion_minor, item.currency)}</span>
                  <Button variant="outline" size="sm" disabled={!compatible(item)} onClick={() => setSelectedItem(item)}>View details</Button>
                </div>
                {!compatible(item) && <p className="mt-2 text-[10px] text-[#4a5568]">Clear your cart to choose different currency or payment terms.</p>}
              </div>
            </article>;
          })}
        </div>
      </>}
    </main>
    {selectedItem && <Modal title={selectedItem.name} onClose={() => setSelectedItem(null)}>
      <div className="space-y-4">
        {selectedItem.image_url[0] && <img src={selectedItem.image_url[0]} alt={selectedItem.name} className="max-h-64 w-full rounded-lg object-cover" />}
        <p className="whitespace-pre-wrap text-sm leading-6 text-[#aab4c5]">{selectedItem.description || "Freshly prepared when you order."}</p>
        <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-3 text-sm"><div className="flex justify-between"><span>Price per portion</span><strong>{formatMoney(selectedItem.price_per_portion_minor, selectedItem.currency)}</strong></div><div className="mt-2 flex justify-between text-[#8892a4]"><span>Plate charge</span><span>{formatMoney(selectedItem.plate_price_minor, selectedItem.currency)} per plate</span></div><div className="mt-2 flex justify-between text-[#8892a4]"><span>Payment</span><span>{key(selectedItem.payment_method) === "Prepaid" ? "Prepaid" : "Cash on delivery"}</span></div></div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setSelectedItem(null)}>Close</Button><Button variant="primary" disabled={!compatible(selectedItem)} onClick={() => openPortionDialog(selectedItem)}><Plus size={14} /> Add</Button></div>
      </div>
    </Modal>}
    {portionItem && <Modal title={`Portions for ${portionItem.name}`} onClose={() => setPortionItem(null)}>
      <div className="space-y-4"><p className="text-sm text-[#8892a4]">How many portions should go on this plate? Adding this item again creates another plate with its own plate charge.</p>
        <Field label="Portions"><Input type="number" min="1" max="100" step="1" value={portionCount} onChange={(event) => setPortionCount(event.target.value)} autoFocus /></Field>
        <div className="flex justify-between rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-3 text-sm"><span>Plate total</span><strong>{formatMoney(portionItem.price_per_portion_minor * BigInt(Number.isSafeInteger(Number(portionCount)) && Number(portionCount) > 0 ? Number(portionCount) : 0) + portionItem.plate_price_minor, portionItem.currency)}</strong></div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setPortionItem(null)}>Cancel</Button><Button variant="primary" disabled={!Number.isSafeInteger(Number(portionCount)) || Number(portionCount) < 1 || Number(portionCount) > 100} onClick={addPlate}>Add plate</Button></div>
      </div>
    </Modal>}
    {checkout && <Modal title="Your order" onClose={() => setCheckout(false)} wide>
      <div className="space-y-4">
        <div className="space-y-2">{cart.map((plate, index) => <div key={plate.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-[#1e2d47] p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">Plate {index + 1}: {plate.item.name}</div><div className="text-xs text-[#8892a4]">{plate.portions} {plate.portions === 1 ? "portion" : "portions"} · plate charge {formatMoney(plate.item.plate_price_minor, plate.item.currency)}</div></div><div className="flex items-center gap-2"><button onClick={() => changePlatePortions(plate.key, -1)} className="rounded border border-[#1e2d47] p-1" aria-label="Remove a portion"><Minus size={14} /></button><span>{plate.portions}</span><button onClick={() => changePlatePortions(plate.key, 1)} className="rounded border border-[#1e2d47] p-1" aria-label="Add a portion to this plate"><Plus size={14} /></button></div><strong className="w-24 text-right font-mono text-sm">{formatMoney(plate.item.price_per_portion_minor * BigInt(plate.portions) + plate.item.plate_price_minor, plate.item.currency)}</strong><Button variant="outline" size="sm" disabled={!compatible(plate.item)} onClick={() => openPortionDialog(plate.item)}>Add Item</Button></div>)}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Your name" /></Field>
          <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="Phone number" /></Field>
          {paymentType === "Prepaid" && <Field label="Email for checkout" className="sm:col-span-2"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" /></Field>}
          <Field label="How would you like your order?" className="sm:col-span-2"><Select value={fulfillment} onChange={(v) => setFulfillment(v as FoodFulfillment)} options={[{ value: "Takeaway", label: "Takeaway / pickup" }, { value: "Delivery", label: "Delivery" }, { value: "DineIn", label: "Dine in" }]} /></Field>
          {fulfillment === "Delivery" && <Field label="Delivery address" className="sm:col-span-2"><Input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" placeholder="Street, area, city" /></Field>}
          {fulfillment === "DineIn" && <Field label="Table number or label" className="sm:col-span-2"><Input value={table} onChange={(e) => setTable(e.target.value)} placeholder="Table 4" /></Field>}
          <Field label="Order note" hint="Optional" className="sm:col-span-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Allergies or special instructions" /></Field>
        </div>
        <div className="flex items-center justify-between border-t border-[#1e2d47] pt-3"><div><p className="text-xs text-[#8892a4]">{paymentType === "Prepaid" ? "Prepaid checkout" : "Cash on delivery"}</p><p className="text-[10px] text-[#4a5568]">Menu prices and plate charges are calculated by the restaurant.</p></div><div className="text-right"><p className="text-xs text-[#8892a4]">Total</p><p className="text-lg font-semibold font-mono">{formatMoney(total, currency)}</p></div></div>
        <div className="flex justify-start"><Button variant="outline" onClick={() => { setCheckout(false); document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" }); }}>Add another dish</Button></div>
        {submitError && <p className="text-xs text-[#ff5252]">{submitError}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCheckout(false)} disabled={busy}>Keep browsing</Button><Button variant="primary" onClick={() => void submitOrder()} disabled={busy || !cart.length}>{busy ? "Placing order…" : "Place order"}</Button></div>
      </div>
    </Modal>}
    {placedOrder && <Modal title={`Order #${placedOrder.id}`} onClose={() => setPlacedOrder(null)} wide>
      <div className="space-y-4 text-center"><CheckCircle2 size={38} className="mx-auto text-[#00e676]" /><h2 className="text-lg font-semibold">Order received</h2><p className="text-sm text-[#8892a4]">Your order is <span className="text-[#e2e8f0]">{key(placedOrder.status)}</span>. We’ll keep this page updated.</p><div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-4 text-left"><div className="flex justify-between text-sm"><span>Total</span><strong className="font-mono">{formatMoney(placedOrder.total_minor, placedOrder.currency)}</strong></div><div className="mt-2 text-xs text-[#8892a4]">Payment: {key(placedOrder.payment_status)}</div></div>{placedOrder.checkout_url[0] && <a href={placedOrder.checkout_url[0]} target="_blank" rel="noreferrer" className="inline-flex rounded bg-[#00d4ff] px-4 py-2 text-sm font-semibold text-[#0a0e1a]">Continue to secure payment</a>}<Button variant="secondary" onClick={() => setPlacedOrder(null)}>Back to menu</Button></div>
    </Modal>}
  </div>;
}
