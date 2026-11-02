import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "./Button";

const MAX_LEN = 2000;

/** Enter sends, Shift+Enter inserts a newline. The draft is only cleared once
 * `onSend` resolves, so a failed send never silently eats what was typed. */
export function Composer({
  placeholder,
  onSend,
  disabled,
  actionLabel = "Send",
}: {
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
  actionLabel?: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(value);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="border-t border-c-line p-3 bg-c-bg">
      {error && <p className="text-xs text-c-danger mb-2 break-words">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          maxLength={MAX_LEN}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="flex-1 resize-none max-h-32 min-h-[38px] px-3 py-2 text-sm bg-c-surface border border-c-line rounded text-c-text placeholder-c-faint focus:outline-none focus:border-c-accent focus:ring-1 focus:ring-c-accent-a33"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        <Button variant="primary" onClick={() => void submit()} disabled={busy || disabled || !text.trim()}>
          <Send size={14} /> {busy ? "Sending…" : actionLabel}
        </Button>
      </div>
    </div>
  );
}
