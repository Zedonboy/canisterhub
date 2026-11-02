import { useMemo, useState } from "react";
import { Search, ShoppingCart, SlidersHorizontal, X } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/Button";
import { ItemImage, KindBadge, Notice, Stepper } from "@/components/bits";
import type { Item, Kind } from "@/lib/api";
import { cart, useCart } from "@/lib/cart";
import { formatMoney, parseMajor } from "@/lib/format";
import { navigate } from "@/lib/router";

type Sort = "newest" | "price-asc" | "price-desc" | "name";
const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "name", label: "Name A-Z" },
];

export const soldOut = (i: Item) => i.stock !== null && i.stock <= 0;

function StockNote({ item, inCart }: { item: Item; inCart: number }) {
  if (soldOut(item)) return <span className="text-xs text-c-danger">Out of stock</span>;
  if (item.stock !== null && item.stock <= 5) return <span className="text-xs text-c-ch-email">Only {item.stock - inCart >= 0 ? item.stock : 0} left</span>;
  return null;
}

function ItemCard({ item }: { item: Item }) {
  const lines = useCart();
  const qty = lines[item.id] ?? 0;
  const out = soldOut(item);
  return (
    <article className="group flex flex-col rounded-xl border border-c-line bg-c-surface overflow-hidden transition-shadow hover:shadow-lg hover:border-c-accent-a44">
      <button onClick={() => navigate(`/item/${item.id}`)} className="text-left" aria-label={`View ${item.name}`}>
        <div className="relative">
          <ItemImage url={item.imageUrl} kind={item.kind} alt={item.name} className={clsx("aspect-[4/3] w-full", out && "opacity-50 grayscale")} />
          {out && <span className="absolute top-2 left-2 text-[11px] font-medium px-2 py-0.5 rounded bg-c-bg text-c-danger border border-c-line">Sold out</span>}
        </div>
        <div className="p-3 pb-1 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <KindBadge kind={item.kind} />
            <StockNote item={item} inCart={qty} />
          </div>
          <h3 className="text-sm font-medium text-c-text leading-snug line-clamp-2 group-hover:text-c-accent">{item.name}</h3>
        </div>
      </button>
      <div className="mt-auto p-3 pt-2 flex items-center justify-between gap-2">
        <span className="font-semibold tabular-nums">{formatMoney(item.priceMinor, item.currency)}</span>
        {qty > 0 ? (
          <Stepper size="sm" value={qty} max={item.stock} onChange={(n) => cart.set(item.id, n)} />
        ) : (
          <Button size="sm" variant="outline" disabled={out} onClick={() => cart.add(item.id)}>
            <ShoppingCart size={13} /> Add
          </Button>
        )}
      </div>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="rounded-xl border border-c-line bg-c-surface overflow-hidden animate-pulse">
          <div className="aspect-[4/3] bg-c-surface2" />
          <div className="p-3 flex flex-col gap-2">
            <div className="h-3 w-1/3 rounded bg-c-surface2" />
            <div className="h-4 w-4/5 rounded bg-c-surface2" />
            <div className="h-4 w-1/3 rounded bg-c-surface2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Catalog({ items, loading, error, reload }: { items: Item[]; loading: boolean; error: string | null; reload: () => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "All">("All");
  const [sort, setSort] = useState<Sort>("newest");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [inStock, setInStock] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const currency = items[0]?.currency ?? "USD";
  const counts = useMemo(() => ({ All: items.length, Product: items.filter((i) => i.kind === "Product").length, Service: items.filter((i) => i.kind === "Service").length }), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const lo = parseMajor(min, currency);
    const hi = parseMajor(max, currency);
    const list = items.filter(
      (i) =>
        (kind === "All" || i.kind === kind) &&
        (!q || `${i.name} ${i.description} ${i.sku ?? ""}`.toLowerCase().includes(q)) &&
        (lo === null || i.priceMinor >= lo) &&
        (hi === null || i.priceMinor <= hi) &&
        (!inStock || !soldOut(i)),
    );
    const by: Record<Sort, (a: Item, b: Item) => number> = {
      newest: (a, b) => b.createdAt - a.createdAt,
      "price-asc": (a, b) => (a.priceMinor < b.priceMinor ? -1 : a.priceMinor > b.priceMinor ? 1 : 0),
      "price-desc": (a, b) => (a.priceMinor > b.priceMinor ? -1 : a.priceMinor < b.priceMinor ? 1 : 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return list.sort(by[sort]);
  }, [items, query, kind, sort, min, max, inStock, currency]);

  const activeFilters = (min || max ? 1 : 0) + (inStock ? 1 : 0) + (kind !== "All" ? 1 : 0);
  const reset = () => {
    setKind("All"); setMin(""); setMax(""); setInStock(false); setQuery("");
  };

  const field = "px-3 py-2 text-sm bg-c-surface border border-c-line rounded-lg text-c-text placeholder-c-faint focus:outline-none focus:border-c-accent focus:ring-1 focus:ring-c-accent-a33";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-c-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products and services"
            aria-label="Search products and services"
            className={clsx(field, "w-full pl-9")}
          />
        </div>
        <div className="flex gap-2">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className={clsx(field, "flex-1 sm:flex-none")}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <Button variant="secondary" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal size={14} /> Filters{activeFilters > 0 && <span className="px-1.5 rounded-full bg-c-accent text-c-on-accent text-[10px]">{activeFilters}</span>}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Type">
        {(["All", "Product", "Service"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={clsx(
              "px-3 py-1.5 rounded-full text-xs border transition-colors",
              kind === k ? "bg-c-accent-a14 text-c-accent border-c-accent-a44" : "text-c-muted border-c-line hover:text-c-text hover:bg-c-surface",
            )}
          >
            {k === "All" ? "Everything" : `${k}s`} <span className="opacity-60">{counts[k]}</span>
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="rounded-xl border border-c-line bg-c-surface p-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-c-muted">
            Min price ({currency})
            <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" className={clsx(field, "w-32")} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-c-muted">
            Max price ({currency})
            <input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="Any" className={clsx(field, "w-32")} />
          </label>
          <label className="flex items-center gap-2 text-sm text-c-text pb-2">
            <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} className="accent-[var(--accent)] w-4 h-4" />
            In stock only
          </label>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
            <X size={13} /> Clear all
          </Button>
        </div>
      )}

      {error && (
        <Notice tone="error">
          Couldn't load the catalogue: {error}{" "}
          <button className="underline" onClick={reload}>Try again</button>
        </Notice>
      )}

      {loading && !items.length ? (
        <Skeleton />
      ) : visible.length === 0 ? (
        <div className="py-16 text-center text-c-muted text-sm flex flex-col items-center gap-3">
          {items.length === 0 ? "Nothing is for sale yet - check back soon." : "No matches for your search and filters."}
          {items.length > 0 && <Button variant="outline" size="sm" onClick={reset}>Clear search & filters</Button>}
        </div>
      ) : (
        <>
          <p className="text-xs text-c-faint" aria-live="polite">{visible.length} {visible.length === 1 ? "result" : "results"}</p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {visible.map((i) => <ItemCard key={i.id} item={i} />)}
          </div>
        </>
      )}
    </div>
  );
}
