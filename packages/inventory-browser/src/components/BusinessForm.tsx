import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/Modal";
import { Field } from "@/components/Field";
import { inventoryApi } from "@/lib/api";
import type { Business } from "@/lib/types";

export function BusinessForm({ business, onClose, onSaved }: { business: Business; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(business.name);
  const [currency, setCurrency] = useState(business.currency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await inventoryApi.setBusiness({ name: name.trim(), currency: currency.trim().toUpperCase() });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title="Business details" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Business name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Default currency" hint="Pre-fills new items. Existing items keep their own currency.">
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} className="font-mono uppercase" maxLength={12} />
        </Field>
        {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving || !name.trim() || !currency.trim()}>
            {saving && <Loader2 size={13} className="animate-spin" />} Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
