import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { clsx } from "clsx";
import { listProducts, type Product } from "@/lib/products";

interface ProductSearchProps {
  compact?: boolean;
  showResults?: boolean;
  onQueryChange?: (query: string) => void;
}

/** Search results stay in the page flow; typing never opens a floating menu. */
export function ProductSearch({
  compact = false,
  showResults = true,
  onQueryChange,
}: ProductSearchProps = {}) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return products.filter((product) =>
      [product.name, product.tagline, product.description].some((value) => value.toLowerCase().includes(q)),
    );
  }, [products, query]);

  useEffect(() => {
    let active = true;
    listProducts().then((value) => active && setProducts(value)).catch(() => active && setProducts([]));
    return () => { active = false; };
  }, []);

  const updateQuery = (value: string) => {
    setQuery(value);
    onQueryChange?.(value);
  };

  return (
    <div className={clsx("w-full", compact ? "max-w-xs" : "max-w-2xl mx-auto")}>
      <div className={clsx(
        "flex items-center bg-[#0f1629] border border-[#1e2d47] hover:border-[#2a3f5f] transition-colors",
        compact ? "gap-2 px-3 py-1.5 rounded-lg" : "gap-4 px-5 py-4 rounded-2xl",
      )}>
        <Search size={compact ? 14 : 22} className="flex-shrink-0 text-[#4a5568]" />
        <input
          type="text"
          placeholder={compact ? "Search packages…" : "Search packages — Auth, Storage, Agents…"}
          className={clsx("flex-1 bg-transparent text-[#e2e8f0] placeholder-[#4a5568] outline-none", compact ? "text-xs" : "text-base")}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          aria-label="Search packages"
        />
        {query && (
          <button aria-label="Clear search" className="text-[#4a5568] hover:text-[#e2e8f0]" onClick={() => updateQuery("")}>
            <X size={compact ? 13 : 16} />
          </button>
        )}
      </div>

      {showResults && query.trim() && (
        <div className="mt-3 space-y-2">
          {filtered.length ? filtered.map((product) => (
            <button
              key={product.id}
              className="flex w-full items-center gap-3 p-3 rounded-xl border border-[#1e2d47] bg-[#0d1526] text-left hover:border-[#00d4ff44] transition-colors"
              onClick={() => navigate(`/market/product/${product.id}`)}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ color: product.color, backgroundColor: product.bgColor, border: `1px solid ${product.borderColor}` }}>
                {product.icon()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#e2e8f0]">{product.name}</div>
                <div className="text-xs text-[#8892a4] truncate">{product.description}</div>
              </div>
              <span className="text-xs text-[#4a5568]">{product.cycleCost}</span>
            </button>
          )) : (
            <p className="px-2 py-4 text-center text-sm text-[#4a5568]">No packages match “{query}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
