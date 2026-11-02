import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ItemThumb } from "@/components/ItemThumb";
import { validateImage } from "@/lib/itemImages";
import type { ItemKind } from "@/lib/types";

export interface ImageChoice {
  /** A newly chosen file, uploaded when the form is saved. */
  file: File | null;
  /** The current image should be deleted when the form is saved. */
  remove: boolean;
}

/** Picks (or clears) an item's image. Nothing is uploaded here - the parent
 * form does that on save, once the item has an id. */
export function ImagePicker({
  kind,
  currentUrl,
  value,
  onChange,
}: {
  kind: ItemKind;
  currentUrl: string | null;
  value: ImageChoice;
  onChange: (choice: ImageChoice) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value.file) return setPreview(null);
    const url = URL.createObjectURL(value.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value.file]);

  const shown = preview ?? (value.remove ? null : currentUrl);

  const choose = (file: File | undefined) => {
    if (!file) return;
    const problem = validateImage(file);
    setError(problem);
    if (!problem) onChange({ file, remove: false });
  };

  return (
    <div className="flex items-center gap-3">
      <ItemThumb url={shown} kind={kind} className="w-16 h-16" />
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
            <ImagePlus size={13} /> {shown ? "Replace image" : "Add image"}
          </Button>
          {shown && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ file: null, remove: currentUrl !== null })}>
              <Trash2 size={13} /> Remove
            </Button>
          )}
        </div>
        <p className="text-[11px] text-[#4a5568]">PNG, JPG or WebP, up to 5 MB. Uploaded when you save.</p>
        {error && <p className="text-[11px] text-[#ff5252]">{error}</p>}
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
