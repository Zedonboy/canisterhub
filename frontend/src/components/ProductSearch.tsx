import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { clsx } from "clsx";
import { listProducts, type Product } from "@/lib/products";

/** `compact`: a slim pill sized for the shared `TopNav` (see that
 * component's own doc comment) instead of the full hero-sized search the
 * Dashboard page used to feature - same filtering/keyboard-nav/dropdown
 * behavior either way, just smaller input chrome. */
export function ProductSearch({ compact = false }: { compact?: boolean } = {}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [products, setProducts] = useState<Product[]>([]);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.tagline.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
    );
  }, [products, query]);

  useEffect(() => {
    let active = true;
    listProducts().then((value) => active && setProducts(value)).catch(() => active && setProducts([]));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSelected((s) => Math.max(s - 1, -1)); }
    if (e.key === "Enter" && selected >= 0) {
      const prod = filtered[selected];
      if (prod) { navigate(`/market/product/${prod.id}`); setOpen(false); }
    }
  };

  return (
    <div ref={containerRef} className={clsx("relative w-full", compact ? "max-w-xs" : "max-w-2xl mx-auto")}>
      <div
        className={clsx(
          "flex items-center bg-[#0f1629] border transition-all duration-200",
          compact ? "gap-2 px-3 py-1.5 rounded-lg" : "gap-4 px-5 py-4 rounded-2xl",
          open
            ? "border-[#00d4ff55] shadow-[0_0_0_4px_#00d4ff0d,0_8px_32px_#00000060]"
            : "border-[#1e2d47] hover:border-[#2a3f5f] shadow-[0_4px_24px_#00000040]"
        )}
      >
        <Search
          size={compact ? 14 : 22}
          className={clsx("flex-shrink-0 transition-colors", open ? "text-[#00d4ff]" : "text-[#4a5568]")}
        />
        <input
          type="text"
          placeholder={compact ? "Search products…" : "Search products — Auth, Storage, Agents, Analytics..."}
          className={clsx("flex-1 bg-transparent text-[#e2e8f0] placeholder-[#4a5568] outline-none", compact ? "text-xs" : "text-base")}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setSelected(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {!open && !compact && (
          <kbd className="hidden sm:block text-[11px] text-[#4a5568] bg-[#1a2236] border border-[#1e2d47] rounded-md px-2 py-1 flex-shrink-0">
            ⌘K
          </kbd>
        )}
        {open && query.length > 0 && (
          <button
            className="text-[11px] text-[#4a5568] hover:text-[#8892a4] transition-colors flex-shrink-0"
            onMouseDown={(e) => { e.preventDefault(); setQuery(""); setSelected(-1); }}
          >
            Clear
          </button>
        )}
      </div>

      {open && (
        <div
          className={clsx(
            "absolute top-full mt-2 bg-[#0d1526] border border-[#1e2d47] rounded-2xl shadow-[0_24px_64px_#00000070] z-50 overflow-hidden animate-fade-in",
            compact ? "left-0 w-80 sm:w-96" : "left-0 right-0 mt-3"
          )}
        >
          {filtered.length > 0 ? (
            <>
              <div className={clsx("grid gap-1.5", compact ? "p-2 grid-cols-1 max-h-96 overflow-y-auto" : "p-3 grid-cols-1 sm:grid-cols-2 gap-2")}>
                {filtered.map((product, i) => (
                  <button
                    key={product.id}
                    className={clsx(
                      "flex items-start text-left transition-all duration-150",
                      compact ? "gap-3 p-2.5 rounded-lg" : "gap-4 p-4 rounded-xl",
                      selected === i
                        ? "bg-[#00d4ff0a] border border-[#00d4ff33] shadow-[0_0_0_1px_#00d4ff22]"
                        : "border border-transparent hover:bg-[#131929] hover:border-[#1e2d47]"
                    )}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => { navigate(`/market/product/${product.id}`); setOpen(false); }}
                  >
                    <div
                      className={clsx("rounded-xl flex items-center justify-center flex-shrink-0", compact ? "w-8 h-8 rounded-lg" : "w-12 h-12")}
                      style={{ color: product.color, backgroundColor: product.bgColor, border: `1.5px solid ${product.borderColor}` }}
                    >
                      {product.icon()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={clsx("font-semibold text-[#e2e8f0]", compact ? "text-xs" : "text-sm")}>{product.name}</span>
                        {!compact && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-md border font-mono"
                            style={{ color: product.color, borderColor: product.borderColor, backgroundColor: product.bgColor }}
                          >
                            {product.cycleCost}
                          </span>
                        )}
                      </div>
                      <div className={clsx("text-[#8892a4] mt-0.5 leading-relaxed line-clamp-1", compact ? "text-[11px]" : "text-xs mt-1 line-clamp-2")}>
                        {product.tagline}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {!compact && (
                <div className="border-t border-[#1e2d47] px-5 py-2.5 flex items-center justify-between text-[11px] text-[#4a5568]">
                  <span>{filtered.length} product{filtered.length !== 1 ? "s" : ""} available</span>
                  <span className="flex items-center gap-2">
                    <kbd className="bg-[#1a2236] border border-[#1e2d47] rounded px-1.5 py-0.5">↑↓</kbd>
                    navigate
                    <span className="text-[#2a3f5f]">·</span>
                    <kbd className="bg-[#1a2236] border border-[#1e2d47] rounded px-1.5 py-0.5">↵</kbd>
                    open
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className={clsx("text-center", compact ? "px-4 py-6" : "px-5 py-10")}>
              <div className={clsx(compact ? "text-xl mb-2" : "text-3xl mb-3")}>🔍</div>
              <div className={clsx("text-[#4a5568]", compact ? "text-xs" : "text-sm")}>
                No products matching <span className="text-[#8892a4]">"{query}"</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
