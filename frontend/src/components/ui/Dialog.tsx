import { useEffect, type ReactNode } from "react";
import { clsx } from "clsx";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, children, className }: DialogProps) {
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" />
      <div
        className={clsx(
          "relative z-10 bg-[#0f1629] border border-[#1e2d47] rounded shadow-2xl animate-fade-in",
          "w-full max-w-lg",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2d47]">
      <h2 className="text-base font-semibold text-[#e2e8f0]">{title}</h2>
      {onClose && (
        <button
          onClick={onClose}
          className="text-[#4a5568] hover:text-[#e2e8f0] transition-colors text-lg leading-none"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("p-5", className)}>{children}</div>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[#1e2d47]">
      {children}
    </div>
  );
}
