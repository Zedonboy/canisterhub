import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { clsx } from "clsx";

/** Absolute form of a module link: `get_links` urls are already resolved to
 * the canister's origin, but a relative one is made absolute here so what's
 * copied always works pasted anywhere. */
export function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Insecure context or permission denied: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** Copies the absolute `url` to the clipboard; shows a check for a moment. */
export function CopyLinkButton({ url, label, className }: { url: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setState((await writeClipboard(absoluteUrl(url))) ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  };

  const title = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : `Copy link to ${label}`;
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      aria-label={title}
      className={clsx(
        "p-1 rounded flex-shrink-0 transition-colors",
        state === "copied" ? "text-[#00e676]" : state === "failed" ? "text-[#ff5252]" : "text-[#8892a4] hover:text-[#00d4ff]",
        className,
      )}
    >
      {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
