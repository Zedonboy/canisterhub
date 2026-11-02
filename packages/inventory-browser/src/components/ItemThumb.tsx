import { useState } from "react";
import { Package, Wrench } from "lucide-react";
import { clsx } from "clsx";
import type { ItemKind } from "@/lib/types";

/** The item's picture, or a kind-specific placeholder when it has none (or
 * the image fails to load). */
export function ItemThumb({ url, kind, className }: { url?: string | null; kind: ItemKind; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = clsx("flex-shrink-0 rounded-md border border-[#1e2d47] bg-[#0a0e1a] overflow-hidden flex items-center justify-center", className ?? "w-10 h-10");
  if (url && !failed) return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} className={clsx(box, "object-cover")} />;
  const Icon = kind === "Service" ? Wrench : Package;
  return (
    <div className={box}>
      <Icon size={16} className="text-[#3d4a63]" />
    </div>
  );
}
