import { useMemo, useState } from "react";
import { Plus, Search, Pencil, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/Field";
import { ItemForm } from "@/components/ItemForm";
import { StockAdjustForm } from "@/components/StockAdjustForm";
import { ItemThumb } from "@/components/ItemThumb";
import { inventoryApi } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { stockLevel } from "@/lib/types";
import type { Business, InventoryItem } from "@/lib/types";

type Filter = "all" | "Product" | "Service" | "attention";

export function StockBadge({ item }: { item: InventoryItem }) {
  const level = stockLevel(item);
  if (!level) return <span className="text-[11px] text-[#4a5568]">not tracked</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono">{item.stock?.toString()}</span>
      {level === "out" && <Badge variant="red">out</Badge>}
      {level === "low" && <Badge variant="amber">low</Badge>}
    </span>
  );
}

export default function InventoryPage({
  business,
  items,
  imagesEnabled,
  onChanged,
}: {
  business: Business;
  items: InventoryItem[];
  /** Whether a storage canister is configured, i.e. whether pictures can be uploaded. */
  imagesEnabled: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<InventoryItem | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<InventoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => {
        if (filter === "Product" || filter === "Service") return i.kind === filter;
        if (filter === "attention") return i.active && (stockLevel(i) === "low" || stockLevel(i) === "out");
        return true;
      })
      .filter((i) => !q || [i.name, i.sku ?? "", i.description].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, filter, query]);

  const toggleActive = async (item: InventoryItem) => {
    try {
      await inventoryApi.updateItem(item.id, { active: !item.active });
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a5568]" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, SKU or description" className="pl-9" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "Product", label: "Products" },
            { value: "Service", label: "Services" },
            { value: "attention", label: "Needs restock" },
          ]}
        />
        <Button variant="primary" className="lg:ml-auto" onClick={() => setEditing("new")}>
          <Plus size={14} /> Add item
        </Button>
      </div>

      {error && <p className="text-xs text-[#ff5252]">{error}</p>}
      {!imagesEnabled && <p className="text-[11px] text-[#4a5568]">Image upload is off - no storage canister is configured for this canister (see the README).</p>}

      <div className="overflow-x-auto border border-[#1e2d47] rounded-lg bg-[#0d1526]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#4a5568] border-b border-[#1e2d47]">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Payment</th>
              <th className="px-4 py-2.5 font-medium text-right">Price</th>
              <th className="px-4 py-2.5 font-medium text-right">Stock</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id.toString()} className="border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] transition-colors group">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <ItemThumb url={i.imageUrl} kind={i.kind} />
                    <div className="min-w-0">
                      <div className={i.active ? "text-[#e2e8f0]" : "text-[#4a5568]"}>{i.name}</div>
                      <div className="text-[11px] text-[#4a5568] truncate max-w-xs">{[i.sku, i.description].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={i.kind === "Product" ? "cyan" : "default"}>{i.kind === "Product" ? "product" : "service"}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-[#9aa8bd]">{i.paymentMethod === "Prepaid" ? "Prepaid" : "Cash on delivery"}</td>
                <td className="px-4 py-2.5 text-right font-mono">{formatMoney(i.priceMinor, i.currency)}</td>
                <td className="px-4 py-2.5 text-right"><StockBadge item={i} /></td>
                <td className="px-4 py-2.5">
                  <button onClick={() => toggleActive(i)} title={i.active ? "Click to deactivate" : "Click to activate"}>
                    <Badge variant={i.active ? "green" : "gray"}>{i.active ? "active" : "inactive"}</Badge>
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-1 sm:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {i.stock !== null && (
                      <Button variant="ghost" size="sm" onClick={() => setAdjusting(i)} title="Adjust stock" aria-label="Adjust stock">
                        <SlidersHorizontal size={13} />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setEditing(i)} title="Edit" aria-label="Edit">
                      <Pencil size={13} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-[#4a5568]">
                  {items.length === 0 ? "No items yet - add your first product or service." : "Nothing matches that filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ItemForm
          item={editing === "new" ? undefined : editing}
          defaultCurrency={business.currency}
          imagesEnabled={imagesEnabled}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
      {adjusting && <StockAdjustForm item={adjusting} onClose={() => setAdjusting(null)} onSaved={onChanged} />}
    </div>
  );
}
