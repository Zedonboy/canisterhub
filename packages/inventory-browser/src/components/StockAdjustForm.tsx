import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/Modal";
import { Field } from "@/components/Field";
import { inventoryApi } from "@/lib/api";
import type { InventoryItem } from "@/lib/types";

/** The canister only takes an absolute `stock_quantity`, so this reads the
 * current figure, applies the +/- change, and writes the result - another
 * order landing in between would be overwritten, which is fine for a
 * deliberate recount/restock but worth knowing. */
export function StockAdjustForm({ item, onClose, onSaved }: { item: InventoryItem; onClose: () => void; onSaved: () => void }) {
  const current = item.stock ?? 0n;
  const [delta, setDelta] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = /^[+-]?\d+$/.test(delta.trim()) ? BigInt(delta.trim()) : null;
  const next = parsed === null ? null : current + parsed;
  const valid = parsed !== null && parsed !== 0n && next !== null && next >= 0n;

  const submit = async () => {
    if (!valid || next === null) return setError(next !== null && next < 0n ? `Only ${current} in stock - can't remove ${-parsed!}.` : "Enter a whole number, e.g. 10 to add or -3 to remove.");
    setSaving(true);
    setError(null);
    try {
      await inventoryApi.updateItem(item.id, { stock: next });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Adjust stock - ${item.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-[#8892a4]">
          Currently <span className="font-mono text-[#e2e8f0]">{current.toString()}</span> in stock.
        </p>
        <Field label="Change" hint="Positive to add stock, negative to remove (damage, loss, correction)">
          <Input value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="numeric" placeholder="+10 or -3" autoFocus onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        {parsed !== null && next !== null && (
          <p className={next < 0n ? "text-xs text-[#ff5252]" : "text-xs text-[#8892a4]"}>
            New stock: <span className="font-mono text-[#e2e8f0]">{next.toString()}</span>
          </p>
        )}
        {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving || !valid}>
            {saving && <Loader2 size={13} className="animate-spin" />} Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}
