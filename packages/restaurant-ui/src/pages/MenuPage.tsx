import { useMemo, useState } from "react";
import { Pencil, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/Field";
import { MenuItemForm } from "@/components/MenuItemForm";
import { ItemThumb } from "@/components/ItemThumb";
import { restaurantApi, type MenuItem } from "@/lib/api";
import { formatMoney } from "@/lib/format";

type Filter = "all" | "available" | "unavailable";

export default function MenuPage({ items, storageEnabled, onChanged }: { items: MenuItem[]; storageEnabled: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<MenuItem | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = useMemo(() => ({ all: items.length, available: items.filter((i) => i.available).length, unavailable: items.filter((i) => !i.available).length }), [items]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => filter === "all" || (filter === "available" ? i.available : !i.available))
      .filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, filter, query]);

  const toggleAvailable = async (item: MenuItem) => {
    try {
      await restaurantApi.updateMenuItem(item.id, { available: !item.available });
      setError(null);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a5568]" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search menu name or description" className="pl-9" />
        </div>
        <Segmented value={filter} onChange={setFilter} options={[
          { value: "all", label: `All (${counts.all})` },
          { value: "available", label: `Available (${counts.available})` },
          { value: "unavailable", label: `Sold out (${counts.unavailable})` },
        ]} />
        <Button variant="primary" className="lg:ml-auto" onClick={() => setEditing("new")}><Plus size={14} /> Add menu item</Button>
      </div>

      {error && <p className="text-xs text-[#ff5252]">{error}</p>}
      <div className="overflow-x-auto border border-[#1e2d47] rounded-lg bg-[#0d1526]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[#4a5568] border-b border-[#1e2d47]">
              <th className="px-4 py-2.5 font-medium">Menu item</th>
              <th className="px-4 py-2.5 font-medium">Payment</th>
              <th className="px-4 py-2.5 font-medium text-right">Per portion</th>
              <th className="px-4 py-2.5 font-medium text-right">Plate charge</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id.toString()} className="border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] transition-colors group">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3"><ItemThumb url={item.image_url[0] ?? null} name={item.name} />
                    <div className="min-w-0"><div className="text-[#e2e8f0]">{item.name}</div>
                      <div className="text-[11px] text-[#4a5568] truncate max-w-sm">{item.description || "No description"}</div></div>
                  </div>
                </td>
                <td className="px-4 py-2.5"><Badge variant={"Prepaid" in item.payment_method ? "cyan" : "gray"}>{"Prepaid" in item.payment_method ? "prepaid" : "cash on delivery"}</Badge></td>
                <td className="px-4 py-2.5 text-right font-mono">{formatMoney(item.price_per_portion_minor, item.currency)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{formatMoney(item.plate_price_minor, item.currency)}</td>
                <td className="px-4 py-2.5">
                  <button onClick={() => void toggleAvailable(item)} title={item.available ? "Mark sold out" : "Make available"}>
                    <Badge variant={item.available ? "green" : "gray"}>{item.available ? "available" : "sold out"}</Badge>
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(item)}><Pencil size={13} /> Edit</Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-[#4a5568]">{items.length ? "Nothing matches that search or filter." : "No menu items yet. Add your first dish."}</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <MenuItemForm item={editing === "new" ? null : editing} defaultCurrency={items[0]?.currency ?? "NGN"} storageEnabled={storageEnabled} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </div>
  );
}
