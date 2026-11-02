import { useEffect } from "react";
import { ShoppingCart, X } from "lucide-react";
import { Button } from "@/components/Button";
import { ItemImage, KindBadge, Stepper } from "@/components/bits";
import type { Item } from "@/lib/api";
import { cart, useCart } from "@/lib/cart";
import { formatMoney } from "@/lib/format";
import { navigate } from "@/lib/router";
import { soldOut } from "./Catalog";

/** Modal over the catalogue, but with its own route (`#/item/<id>`) so it can
 * be linked, shared, and closed with the browser's back button. */
export default function ItemDetail({ item, loading }: { item: Item | undefined; loading: boolean }) {
  const lines = useCart();
  const close = () => navigate("/");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const qty = item ? (lines[item.id] ?? 0) : 0;
  const out = item ? soldOut(item) : false;

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={item?.name ?? "Item"}>
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="relative w-full sm:max-w-3xl max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-c-bg border border-c-line shadow-2xl">
        <Button variant="ghost" size="sm" className="absolute top-2 right-2 z-10 bg-c-bg/80 backdrop-blur" onClick={close} aria-label="Close">
          <X size={16} />
        </Button>
        {!item ? (
          <p className="p-10 text-center text-sm text-c-muted">{loading ? "Loading…" : "This item is no longer available."}</p>
        ) : (
          <div className="grid sm:grid-cols-2">
            <ItemImage url={item.imageUrl} kind={item.kind} alt={item.name} className="aspect-[4/3] sm:aspect-square w-full" />
            <div className="p-5 flex flex-col gap-3">
              <KindBadge kind={item.kind} />
              <h2 className="text-xl font-semibold leading-snug">{item.name}</h2>
              <p className="text-2xl font-semibold tabular-nums">{formatMoney(item.priceMinor, item.currency)}</p>
              <p className="text-sm text-c-muted whitespace-pre-wrap">{item.description}</p>
              <p className="text-xs text-c-faint">
                {item.kind === "Service" ? "Service" : out ? "Out of stock" : item.stock === null ? "In stock" : `${item.stock} in stock`}
                {item.sku && ` · SKU ${item.sku}`}
              </p>
              <div className="mt-auto pt-3 flex items-center gap-3 flex-wrap">
                {qty > 0 ? (
                  <>
                    <Stepper value={qty} max={item.stock} onChange={(n) => cart.set(item.id, n)} />
                    <Button variant="primary" onClick={() => navigate("/cart")}>
                      <ShoppingCart size={15} /> View cart
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" size="lg" disabled={out} onClick={() => cart.add(item.id)}>
                    <ShoppingCart size={16} /> {out ? "Sold out" : "Add to cart"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
