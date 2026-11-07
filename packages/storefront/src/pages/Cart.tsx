import { useMemo, useState } from "react";
import { ArrowLeft, Banknote, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { ItemImage, Notice, Stepper } from "@/components/bits";
import { SignInCard } from "@/components/SignInCard";
import { placeOrder, type Item } from "@/lib/api";
import { cart, useCart } from "@/lib/cart";
import { formatMoney, errorText } from "@/lib/format";
import { navigate } from "@/lib/router";
import { soldOut } from "./Catalog";

type Auth = { status: "loading" | "anonymous" | "authenticated"; signIn: () => Promise<void> };

const input =
  "w-full px-3 py-2 text-sm bg-c-surface border border-c-line rounded-lg text-c-text placeholder-c-faint focus:outline-none focus:border-c-accent focus:ring-1 focus:ring-c-accent-a33";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-c-muted">
      <span>{label}{required && <span className="text-c-danger"> *</span>}</span>
      {children}
    </label>
  );
}

export default function Cart({ items, loading, auth, onOrdered }: { items: Item[]; loading: boolean; auth: Auth; onOrdered: () => void }) {
  const lines = useCart();
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", instructions: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      Object.entries(lines).map(([id, quantity]) => ({ id: Number(id), quantity, item: items.find((i) => i.id === Number(id)) })),
    [lines, items],
  );
  const missing = rows.filter((r) => !r.item);
  const found = rows.filter((r): r is typeof r & { item: Item } => !!r.item);
  const unavailable = found.filter((r) => soldOut(r.item) || (r.item.stock !== null && r.quantity > r.item.stock));
  const currencies = new Set(found.map((r) => r.item.currency));
  const mixed = currencies.size > 1;
  const mixedPayment = new Set(found.map((r) => r.item.paymentMethod)).size > 1;
  const needsEmail = found.some((r) => r.item.paymentMethod === "Prepaid");
  const currency = found[0]?.item.currency ?? "";
  const total = found.reduce((s, r) => s + r.item.priceMinor * BigInt(r.quantity), 0n);
  const blocked = mixed || mixedPayment || missing.length > 0 || unavailable.length > 0 || found.length === 0;
  const formOk = form.name.trim() && form.phone.trim() && form.address.trim() && (!needsEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  if (loading && items.length === 0) return <p className="py-16 text-center text-sm text-c-muted">Loading your cart…</p>;

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center flex flex-col items-center gap-3">
        <p className="text-sm text-c-muted">Your cart is empty.</p>
        <Button variant="primary" onClick={() => navigate("/")}>Browse the store</Button>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked || !formOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const order = await placeOrder({ lines: found.map((r) => ({ id: r.id, quantity: r.quantity })), ...form });
      cart.clear();
      onOrdered();
      if (order.checkoutUrl) {
        window.location.assign(order.checkoutUrl);
        return;
      }
      navigate(`/orders?placed=${order.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid lg:grid-cols-[1fr_380px] gap-6 items-start">
      <section className="flex flex-col gap-3">
        <button onClick={() => navigate("/")} className="self-start inline-flex items-center gap-1 text-xs text-c-muted hover:text-c-text">
          <ArrowLeft size={13} /> Continue shopping
        </button>
        <h1 className="text-lg font-semibold">Your cart</h1>

        {missing.length > 0 && (
          <Notice tone="error">
            {missing.length === 1 ? "An item in your cart is" : `${missing.length} items in your cart are`} no longer available.{" "}
            <button className="underline" onClick={() => missing.forEach((m) => cart.remove(m.id))}>Remove</button>
          </Notice>
        )}
        {mixed && <Notice tone="error">Your cart mixes currencies ({[...currencies].join(", ")}). Remove items until they share one currency.</Notice>}
        {mixedPayment && <Notice tone="error">Your cart has different vendor payment terms. Place separate orders for prepaid and cash on delivery items.</Notice>}

        <ul className="flex flex-col divide-y divide-c-line rounded-xl border border-c-line bg-c-surface">
          {found.map(({ item, quantity }) => {
            const bad = soldOut(item) || (item.stock !== null && quantity > item.stock);
            return (
              <li key={item.id} className="p-3 flex gap-3">
                <button onClick={() => navigate(`/item/${item.id}`)} aria-label={`View ${item.name}`}>
                  <ItemImage url={item.imageUrl} kind={item.kind} alt="" className="w-20 h-20 rounded-lg shrink-0" />
                </button>
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-medium truncate">{item.name}</span>
                    <span className="text-sm font-semibold tabular-nums">{formatMoney(item.priceMinor * BigInt(quantity), item.currency)}</span>
                  </div>
                  <span className="text-xs text-c-faint">{formatMoney(item.priceMinor, item.currency)} each</span>
                  <span className="text-[11px] text-c-muted">{item.paymentMethod === "Prepaid" ? "Prepaid" : "Cash on delivery"}</span>
                  {bad && (
                    <span className="text-xs text-c-danger">
                      {soldOut(item) ? "Out of stock" : `Only ${item.stock} available`} -{" "}
                      <button className="underline" onClick={() => (soldOut(item) ? cart.remove(item.id) : cart.set(item.id, item.stock!))}>
                        {soldOut(item) ? "remove" : "adjust"}
                      </button>
                    </span>
                  )}
                  <div className="mt-auto flex items-center justify-between">
                    <Stepper size="sm" value={quantity} max={item.stock} onChange={(n) => cart.set(item.id, n)} />
                    <button onClick={() => cart.remove(item.id)} aria-label={`Remove ${item.name}`} className="p-1.5 text-c-faint hover:text-c-danger">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <aside className="flex flex-col gap-3 lg:sticky lg:top-20">
        <div className="rounded-xl border border-c-line bg-c-surface p-4 flex flex-col gap-2">
          <div className="flex justify-between text-sm text-c-muted"><span>Subtotal</span><span className="tabular-nums">{!mixed && formatMoney(total, currency)}</span></div>
          <div className="flex justify-between text-sm text-c-muted"><span>Delivery</span><span>Confirmed by the shop</span></div>
          <div className="flex justify-between font-semibold pt-2 border-t border-c-line"><span>Total</span><span className="tabular-nums">{!mixed && formatMoney(total, currency)}</span></div>
        </div>

        {auth.status === "loading" ? null : auth.status === "anonymous" ? (
          <SignInCard reason="Sign in to place your order and track it afterwards." onSignIn={auth.signIn} />
        ) : (
          <form onSubmit={submit} className="rounded-xl border border-c-line bg-c-surface p-4 flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Delivery details</h2>
            <Field label="Full name" required><input className={input} value={form.name} onChange={set("name")} autoComplete="name" maxLength={100} required /></Field>
            <Field label="Phone number" required><input className={input} value={form.phone} onChange={set("phone")} autoComplete="tel" inputMode="tel" maxLength={40} required /></Field>
            <Field label="Email address" required={needsEmail}><input className={input} value={form.email} onChange={set("email")} autoComplete="email" type="email" maxLength={254} required={needsEmail} /></Field>
            <Field label="Delivery / service address" required><textarea className={input} rows={2} value={form.address} onChange={set("address")} autoComplete="street-address" maxLength={500} required /></Field>
            <Field label="Delivery instructions"><input className={input} value={form.instructions} onChange={set("instructions")} placeholder="Gate code, landmark…" maxLength={300} /></Field>
            <Field label="Note to the shop"><input className={input} value={form.note} onChange={set("note")} maxLength={500} /></Field>
            <div className="flex items-center gap-2 text-xs text-c-muted rounded-lg bg-c-surface2 px-3 py-2">
              <Banknote size={14} className="text-c-accent" /> {mixedPayment ? "Separate orders are required for different payment terms." : found[0]?.item.paymentMethod === "Prepaid" ? "This order is prepaid; the shop will provide payment instructions." : "Cash on delivery; pay when your order arrives."}
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" variant="primary" size="lg" disabled={blocked || !formOk || busy}>
              {busy ? "Placing order…" : `Place order${mixed ? "" : ` · ${formatMoney(total, currency)}`}`}
            </Button>
            {blocked && <p className="text-xs text-c-faint">Resolve the issues above to continue.</p>}
          </form>
        )}
      </aside>
    </div>
  );
}
