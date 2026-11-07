import { useMemo, useState } from "react";
import { Dices, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/Modal";
import { Field, Segmented, Select } from "@/components/Field";
import { ImagePicker, type ImageChoice } from "@/components/ImagePicker";
import { inventoryApi } from "@/lib/api";
import { currencyOptions } from "@/lib/currencies";
import { generateSku } from "@/lib/sku";
import { minorToInput, parseCount, parseMoney } from "@/lib/format";
import { deleteItemImage, uploadItemImage } from "@/lib/itemImages";
import type { InventoryItem, ItemKind, PaymentMethod } from "@/lib/types";

/** Create (no `item`) or edit. Stock on an existing item is changed with
 * the separate Adjust stock action, but "track stock" itself is editable
 * here (a service usually isn't tracked; a product usually is). */
export function ItemForm({
  item,
  defaultCurrency,
  imagesEnabled,
  onClose,
  onSaved,
}: {
  item?: InventoryItem;
  defaultCurrency: string;
  /** Whether a storage canister is configured - without one the picker is hidden. */
  imagesEnabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? "Product");
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [sku, setSku] = useState(item?.sku ?? "");
  const [currency, setCurrency] = useState(item?.currency ?? defaultCurrency);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(item?.paymentMethod ?? "CashOnDelivery");
  const currencies = useMemo(() => currencyOptions(item?.currency ?? defaultCurrency), [item?.currency, defaultCurrency]);
  const [price, setPrice] = useState(item ? minorToInput(item.priceMinor, item.currency) : "");
  const [tracked, setTracked] = useState(item ? item.stock !== null : true);
  const [stock, setStock] = useState("0");
  const [active, setActive] = useState(item?.active ?? true);
  const [image, setImage] = useState<ImageChoice>({ file: null, remove: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const cur = currency.trim().toUpperCase();
    const priceMinor = parseMoney(price, cur);
    const openingStock = parseCount(stock);
    if (!name.trim()) return setError("Name is required.");
    if (priceMinor === null) return setError("Enter a valid price (no more decimals than the currency uses).");
    if (!item && tracked && openingStock === null) return setError("Opening stock must be a whole number, 0 or more.");
    setSaving(true);
    setError(null);
    try {
      // Upload first, so the URL is saved together with the rest of the item
      // in one canister call (and a failed upload creates nothing).
      let uploaded: string | null = null;
      if (image.file) uploaded = await uploadItemImage(image.file);
      const imageUrl = image.file ? uploaded : image.remove ? null : (item?.imageUrl ?? null);
      const common = { kind, name, description, sku: sku.trim() || null, priceMinor, currency: cur, paymentMethod, imageUrl, active };
      try {
        if (item) {
          // keep the current quantity when tracking stays on; `null` stops tracking
          await inventoryApi.updateItem(item.id, { ...common, stock: tracked ? (item.stock ?? 0n) : null });
        } else {
          await inventoryApi.createItem({ ...common, stock: tracked ? openingStock : null });
        }
      } catch (e) {
        // the item wasn't saved, so the file just uploaded would be orphaned
        if (uploaded) void deleteItemImage(uploaded);
        throw e;
      }
      // saved: the previous picture (replaced or removed) is no longer referenced
      if (item?.imageUrl && item.imageUrl !== imageUrl) void deleteItemImage(item.imageUrl);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title={item ? `Edit ${item.name}` : "Add item"} onClose={onClose}>
      <div className="space-y-4">
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k);
            // services default to untracked, products to tracked - only while creating
            if (!item) setTracked(k === "Product");
          }}
          options={[
            { value: "Product", label: "Product" },
            { value: "Service", label: "Service" },
          ]}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name" className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="SKU" hint={item?.sku ? "A SKU can be changed but not cleared" : "Optional unique code"}>
            <div className="flex gap-2">
              <Input value={sku} onChange={(e) => setSku(e.target.value)} className="font-mono" />
              <Button type="button" variant="secondary" onClick={() => setSku(generateSku(name, kind))} title="Generate a random SKU" aria-label="Generate a random SKU">
                <Dices size={14} />
              </Button>
            </div>
          </Field>
          <Field label="Currency">
            <Select value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c.code, label: c.label }))} />
          </Field>
          <Field label="Payment terms" hint="Set by the vendor; customers cannot change this.">
            <Select
              value={paymentMethod}
              onChange={(value) => setPaymentMethod(value as PaymentMethod)}
              options={[
                { value: "CashOnDelivery", label: "Cash on delivery" },
                { value: "Prepaid", label: "Prepaid" },
              ]}
            />
          </Field>
          <Field label={kind === "Service" ? "Price" : "Selling price"}>
            <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
          </Field>
          {!item && tracked && (
            <Field label="Opening stock">
              <Input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" />
            </Field>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-[#e2e8f0]">
          <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} className="accent-[#00d4ff]" />
          Track stock <span className="text-xs text-[#4a5568]">(orders are refused when stock runs out)</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-[#e2e8f0]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-[#00d4ff]" />
          Active <span className="text-xs text-[#4a5568]">(inactive items can't be ordered)</span>
        </label>
        {imagesEnabled && <ImagePicker kind={kind} currentUrl={item?.imageUrl ?? null} value={image} onChange={setImage} />}
        {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving && <Loader2 size={13} className="animate-spin" />} {item ? "Save changes" : "Add item"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
