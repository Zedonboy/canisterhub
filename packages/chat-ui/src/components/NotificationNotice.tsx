import { useEffect, useRef, useState } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/Button";
import { enablePush, isPushSupported } from "@/lib/push";
import { errorText } from "@/lib/format";

const MOCK = import.meta.env.VITE_MOCK === "1";
const seenKey = (principal: string) => `chat-notice-seen:${principal}`;

function alreadySeen(principal: string): boolean {
  try {
    return localStorage.getItem(seenKey(principal)) === "1";
  } catch {
    return false;
  }
}

/** Shown once per signed-in customer (per browser) to offer backend-owned
 * push notifications for replies that arrive after they leave the chat. */
export function NotificationNotice({ principal }: { principal: string }) {
  const [open, setOpen] = useState(() => !alreadySeen(principal));
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEnable = MOCK || isPushSupported();

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!MOCK) await enablePush();
      ref.current?.close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;

  const close = () => {
    try {
      localStorage.setItem(seenKey(principal), "1");
    } catch {
      // Storage blocked: the notice may show again next visit, which is harmless.
    }
    setOpen(false);
  };

  return (
    <dialog
      ref={ref}
      onClose={close}
      aria-labelledby="notice-title"
      className="m-auto w-[min(92vw,24rem)] rounded-xl border border-c-line bg-c-surface text-c-text p-0 backdrop:bg-black/60"
    >
      <div className="p-6 flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-full bg-c-accent-a14 border border-c-accent-a44 flex items-center justify-center">
          <BellRing size={22} className="text-c-accent" />
        </div>
        <h2 id="notice-title" className="text-base font-semibold">
          Don't miss a reply
        </h2>
        <p className="text-sm text-c-muted">
          Our team and assistant may answer after you've left this page - confirming an order, or asking a quick
          question. Notifications are how you'll know there's something waiting, so you don't have to keep checking
          back.
        </p>
        {error && <p className="text-xs text-c-danger break-words">{error}</p>}
        {canEnable ? (
          <>
            <Button variant="primary" size="md" className="mt-2 w-full justify-center" disabled={busy} onClick={() => void enable()}>
              {busy ? "Turning on…" : "Turn on notifications"}
            </Button>
            <Button variant="ghost" size="sm" className="w-full justify-center" disabled={busy} onClick={() => ref.current?.close()}>
              Not now
            </Button>
          </>
        ) : (
          <Button variant="primary" size="md" className="mt-2 w-full justify-center" onClick={() => ref.current?.close()}>
            Got it
          </Button>
        )}
      </div>
    </dialog>
  );
}
