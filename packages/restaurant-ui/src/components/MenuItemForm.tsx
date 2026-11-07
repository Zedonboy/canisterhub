import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field, Select } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { ImagePicker, type ImageChoice } from "@/components/ImagePicker";
import { restaurantApi, type MenuItem } from "@/lib/api";
import type * as C from "@/lib/candid/restaurant";
import { currencyOptions } from "@/lib/currencies";
import { minorToInput, parseMoney } from "@/lib/format";
import { deleteItemImage, uploadItemImage } from "@/lib/itemImages";

export function MenuItemForm({ item, defaultCurrency, storageEnabled, onClose, onSaved }: { item: MenuItem | null; defaultCurrency: string; storageEnabled: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [price, setPrice] = useState(item ? minorToInput(item.price_per_portion_minor, item.currency) : "");
  const [platePrice, setPlatePrice] = useState(item ? minorToInput(item.plate_price_minor, item.currency) : "0");
  const [currency, setCurrency] = useState(item?.currency ?? defaultCurrency);
  const [payment, setPayment] = useState<C.PaymentMethod>(item?.payment_method ?? { CashOnDelivery: null });
  const [available, setAvailable] = useState(item?.available ?? true);
  const [image, setImage] = useState<ImageChoice>({ file: null, remove: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currencies = useMemo(() => currencyOptions(item?.currency ?? defaultCurrency), [item?.currency, defaultCurrency]);

  const submit = async () => {
    const code = currency.trim().toUpperCase();
    const priceMinor = parseMoney(price, code);
    const plateMinor = parseMoney(platePrice || "0", code);
    if (!name.trim()) return setError("Name is required.");
    if (priceMinor === null || plateMinor === null) return setError("Enter valid non-negative prices for this currency.");
    if (!/^[A-Z0-9]{2,12}$/.test(code)) return setError("Currency must be 2-12 letters or digits (for example NGN).");
    const input: C.MenuInput = { name: name.trim(), description: description.trim(), price_per_portion_minor: priceMinor, plate_price_minor: plateMinor, image_url: [], currency: code, payment_method: payment, available };
    setBusy(true); setError(null);
    let uploaded: string | null = null;
    try {
      uploaded = image.file ? await uploadItemImage(image.file) : null;
      const imageUrl = uploaded ?? (image.remove ? null : item?.image_url[0] ?? null);
      if (item) {
        await restaurantApi.updateMenuItem(item.id, { ...input, image_url: image.file ? [uploaded!] : image.remove ? [""] : undefined });
      } else {
        await restaurantApi.createMenuItem({ ...input, image_url: uploaded ? [uploaded] : [] });
      }
      if (item?.image_url[0] && item.image_url[0] !== imageUrl) void deleteItemImage(item.image_url[0]);
      onSaved(); onClose();
    } catch (e) { if (uploaded) void deleteItemImage(uploaded); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={item ? `Edit ${item.name}` : "Add menu item"} onClose={busy ? () => undefined : onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Dish name" className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jollof rice" autoFocus /></Field>
          <Field label="Description" hint="Optional, shown on the public menu." className="sm:col-span-2"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Smoky party-style jollof" /></Field>
          <Field label="Price per portion" hint="Customers choose the portion count."><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2,500.00" inputMode="decimal" /></Field>
          <Field label="Plate charge" hint="The system adds this charge once for each plate."><Input value={platePrice} onChange={(e) => setPlatePrice(e.target.value)} placeholder="100.00" inputMode="decimal" /></Field>
          <Field label="Currency"><Select value={currency} onChange={setCurrency} options={currencies.map((c) => ({ value: c.code, label: c.label }))} /></Field>
          <Field label="Payment terms" hint="Set by the restaurant."><Select value={"Prepaid" in payment ? "Prepaid" : "CashOnDelivery"} onChange={(v) => setPayment(v === "Prepaid" ? { Prepaid: null } : { CashOnDelivery: null })} options={[{ value: "CashOnDelivery", label: "Cash on delivery" }, { value: "Prepaid", label: "Prepaid checkout" }]} /></Field>
        </div>
        <ImagePicker name={name || "Menu item"} currentUrl={item?.image_url[0] ?? null} value={image} enabled={storageEnabled} onChange={setImage} />
        <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a]/60 px-3 py-2.5 text-xs text-[#8892a4]">Each plate costs <span className="text-[#e2e8f0]">portion price × portions + one plate charge</span>.</div>
        <label className="flex items-center gap-2 text-sm text-[#e2e8f0]"><input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} className="w-4 h-4 accent-[#00d4ff]" /> Available for ordering <span className="text-xs text-[#4a5568]">(turn off when sold out)</span></label>
        {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-[#1e2d47] pt-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>{busy && <Loader2 size={13} className="animate-spin" />}{item ? "Save changes" : "Add menu item"}</Button>
        </div>
      </div>
    </Modal>
  );
}
