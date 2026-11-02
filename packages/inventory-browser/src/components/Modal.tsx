import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { clsx } from "clsx";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 bg-black/60 overflow-y-auto" onMouseDown={onClose}>
      <div
        className={clsx("w-full bg-[#0d1526] border border-[#1e2d47] rounded-xl shadow-2xl my-auto", wide ? "max-w-3xl" : "max-w-lg")}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e2d47]">
          <h2 className="text-sm font-semibold text-[#e2e8f0]">{title}</h2>
          <button onClick={onClose} className="text-[#8892a4] hover:text-[#e2e8f0]" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
