// Payments admin shell: the embedding payment canister's name in the
// header, the signed-in identity top-right, and two tabs - the
// transaction log and the module's own dynamic-config settings. Every
// call behind those tabs is controller-gated on the canister side, so an
// anonymous visitor only ever sees the sign-in gate.

import { useEffect, useState } from "react";
import { CreditCard, ListTree, Settings2 } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/Button";
import TransactionsPanel from "@/components/TransactionsPanel";
import SettingsPanel from "@/components/SettingsPanel";
import type { CanisterMetadata } from "@/lib/candid/payment";
import { network } from "@/lib/canisterId";
import { useAuth } from "@/lib/auth";
import { getPaymentActor } from "@/lib/paymentActor";

type Tab = "transactions" | "settings";

function AuthControl() {
  const { status, principal, delegated, signIn, signOut } = useAuth();

  if (status === "loading") {
    return <span className="text-[10px] text-c-faint">Resolving session…</span>;
  }
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2">
        <span
          className="max-w-[160px] truncate font-mono text-[10px] text-c-faint"
          title={principal ?? undefined}
        >
          {principal}
        </span>
        {!delegated && (
          <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => undefined)}>
            Sign out
          </Button>
        )}
      </div>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => signIn().catch(() => undefined)}>
      Sign in
    </Button>
  );
}

export default function App() {
  const { status } = useAuth();
  const [tab, setTab] = useState<Tab>("transactions");
  const [metadata, setMetadata] = useState<CanisterMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPaymentActor()
      .then((actor) => actor.canister_metadata())
      .then((meta) => {
        if (!cancelled) setMetadata(meta);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-c-line bg-c-surface px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-c-accent" />
          <h1 className="text-sm font-semibold capitalize">{metadata?.name ?? "Payments"}</h1>
          {metadata && (
            <span className="rounded border border-c-line px-1.5 py-0.5 text-[10px] text-c-faint">
              v{metadata.version}
            </span>
          )}
          <span className="rounded border border-c-line px-1.5 py-0.5 font-mono text-[10px] text-c-faint">
            {network()}
          </span>
        </div>
        <AuthControl />
      </header>

      {status === "anonymous" ? (
        <main className="grid flex-1 place-items-center p-6">
          <div className="max-w-sm space-y-3 rounded-lg border border-c-line bg-c-surface p-6 text-center">
            <CreditCard size={22} className="mx-auto text-c-accent" />
            <h2 className="text-sm font-semibold">Sign in to manage payments</h2>
            <p className="text-xs leading-relaxed text-c-muted">
              The transaction log and settings are controller-only. Sign in with Internet
              Identity (or open this page from the dashboard, which shares its session).
            </p>
            <AuthControl />
          </div>
        </main>
      ) : (
        <main className="flex-1 space-y-4 p-4">
          <nav className="flex gap-1 border-b border-c-line">
            {(
              [
                { key: "transactions", label: "Transactions", icon: ListTree },
                { key: "settings", label: "Settings", icon: Settings2 },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={clsx(
                  "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                  tab === key
                    ? "border-c-accent text-c-text"
                    : "border-transparent text-c-muted hover:text-c-text"
                )}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </nav>
          {tab === "transactions" ? <TransactionsPanel /> : <SettingsPanel />}
        </main>
      )}
    </div>
  );
}
