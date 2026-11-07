import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ItemThumb } from "@/components/ItemThumb";
import { validateImage } from "@/lib/itemImages";

export interface ImageChoice { file: File | null; remove: boolean }

export function ImagePicker({ name, currentUrl, value, enabled, onChange }: {
  name: string; currentUrl: string | null; value: ImageChoice; enabled: boolean;
  onChange: (choice: ImageChoice) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!value.file) { setPreview(null); return; }
    const url = URL.createObjectURL(value.file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value.file]);
  const shown = preview ?? (value.remove ? null : currentUrl);
  const choose = (file?: File) => {
    if (!file) return;
    const problem = validateImage(file); setError(problem);
    if (!problem) onChange({ file, remove: false });
  };

  return <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a]/60 p-3">
    <div className="flex items-center gap-3"><ItemThumb url={shown} name={name} className="h-16 w-16" /><div className="space-y-1.5">
      <div className="flex gap-2"><Button type="button" variant="secondary" size="sm" disabled={!enabled} onClick={() => input.current?.click()}><ImagePlus size={13} />{shown ? "Replace photo" : "Add photo"}</Button>{shown && <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ file: null, remove: true })}><Trash2 size={13} />Remove</Button>}</div>
      <p className="text-[11px] text-[#4a5568]">JPG, PNG or WebP · up to 5 MB</p>
      {!enabled && <p className="text-[11px] text-[#ffab40]">Configure a Storage Canister in package settings to upload menu photos.</p>}
      {error && <p className="text-[11px] text-[#ff5252]">{error}</p>}
    </div></div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
  </div>;
}
