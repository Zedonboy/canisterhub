import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { Button } from "./Button";
import { errorText } from "@/lib/format";

/** Internet Identity gate. `reason` says what signing in unlocks. */
export function SignInCard({ reason, onSignIn }: { reason: string; onSignIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rounded-xl border border-c-line bg-c-surface p-6 flex flex-col items-center text-center gap-3">
      <div className="w-12 h-12 rounded-full bg-c-accent-a14 border border-c-accent-a44 flex items-center justify-center">
        <Fingerprint size={22} className="text-c-accent" />
      </div>
      <h3 className="font-semibold">Sign in to continue</h3>
      <p className="text-sm text-c-muted max-w-sm">{reason} Use Internet Identity - a passkey or your device's biometrics. No password or email.</p>
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          onSignIn().catch((e) => setError(errorText(e))).finally(() => setBusy(false));
        }}
      >
        <Fingerprint size={15} /> {busy ? "Waiting for Internet Identity…" : "Sign in with Internet Identity"}
      </Button>
      {error && <p className="text-xs text-c-danger break-words">{error}</p>}
    </div>
  );
}
