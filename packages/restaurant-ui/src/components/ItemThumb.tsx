import { UtensilsCrossed } from "lucide-react";
import { clsx } from "clsx";

export function ItemThumb({ url, name, className }: { url: string | null; name: string; className?: string }) {
  return <div className={clsx("flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#1e2d47] bg-[#101a2c]", className)}>
    {url ? <img src={url} alt={name} className="h-full w-full object-cover" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <UtensilsCrossed size={18} className="text-[#4a5568]" />}
  </div>;
}
