import { useState, useEffect, type ReactNode } from "react";
import { clsx } from "clsx";
import { X, CheckCircle, AlertTriangle, XCircle, Info } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
}

let _addToast: ((t: Omit<ToastItem, "id">) => void) | null = null;

export function toast(type: ToastType, title: string, message?: string) {
  _addToast?.({ type, title, message });
}
toast.success = (title: string, message?: string) => toast("success", title, message);
toast.error   = (title: string, message?: string) => toast("error",   title, message);
toast.warning = (title: string, message?: string) => toast("warning", title, message);
toast.info    = (title: string, message?: string) => toast("info",    title, message);

const icons: Record<ToastType, ReactNode> = {
  success: <CheckCircle size={16} className="text-[#00e676]" />,
  error:   <XCircle     size={16} className="text-[#ff5252]" />,
  warning: <AlertTriangle size={16} className="text-[#ffab40]" />,
  info:    <Info        size={16} className="text-[#00d4ff]" />,
};

const colors: Record<ToastType, string> = {
  success: "border-[#00e67644] bg-[#00e67611]",
  error:   "border-[#ff525244] bg-[#ff525211]",
  warning: "border-[#ffab4044] bg-[#ffab4011]",
  info:    "border-[#00d4ff44] bg-[#00d4ff11]",
};

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  let counter = 0;

  useEffect(() => {
    _addToast = (t) => {
      const id = ++counter;
      setToasts((prev) => [...prev, { ...t, id }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, 4000);
    };
    return () => { _addToast = null; };
  }, []);

  const remove = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id));

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col items-stretch sm:items-end gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "flex items-start gap-3 px-4 py-3 rounded border shadow-xl pointer-events-auto animate-slide-in-up",
            "bg-[#0f1629] w-full sm:w-auto sm:min-w-[300px] max-w-full sm:max-w-[420px]",
            colors[t.type]
          )}
        >
          <div className="mt-0.5 flex-shrink-0">{icons[t.type]}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[#e2e8f0]">{t.title}</div>
            {t.message && (
              <div className="text-xs text-[#8892a4] mt-0.5">{t.message}</div>
            )}
          </div>
          <button
            onClick={() => remove(t.id)}
            className="text-[#4a5568] hover:text-[#e2e8f0] flex-shrink-0 mt-0.5 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
