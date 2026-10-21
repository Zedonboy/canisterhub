import { useState } from "react";
import { clsx } from "clsx";
import { Copy, Check } from "lucide-react";
import { truncatePrincipal } from "@/lib/mock-data";

interface CanisterIDProps {
  id: string;
  chars?: number;
  className?: string;
  showFull?: boolean;
}

export function CanisterID({ id, chars, className, showFull }: CanisterIDProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const display = showFull ? id : truncatePrincipal(id, chars ?? 6);

  return (
    <span className={clsx("inline-flex items-center gap-1.5 group", className)}>
      <span className="font-mono text-xs text-[#00d4ff] cursor-pointer" title={id}>
        {display}
      </span>
      <button
        onClick={copy}
        className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-[#4a5568] hover:text-[#00d4ff] flex-shrink-0"
        title="Copy full ID"
      >
        {copied ? <Check size={11} className="text-[#00e676]" /> : <Copy size={11} />}
      </button>
    </span>
  );
}
