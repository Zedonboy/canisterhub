// The transaction log: every charge this payment module has created,
// newest first, with the verification outcome the canister last recorded
// for it. Polls on an interval like the dashboard's Logs page, plus a
// manual Refresh for the impatient.

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, ExternalLink, RefreshCw } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/Button";
import type { Transaction } from "@/lib/candid/payment";
import { getPaymentActor } from "@/lib/paymentActor";
import { formatAmount, formatTimestamp, shortRef } from "@/lib/format";

const POLL_MS = 8_000;

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const palette =
    normalized === "paid"
      ? "text-c-ok bg-c-ok-a22 border-c-ok/30"
      : normalized === "failed"
        ? "text-c-danger bg-c-danger-a22 border-c-danger/30"
        : "text-c-warn bg-c-warn-a22 border-c-warn/30";
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        palette
      )}
    >
      {status}
    </span>
  );
}

export default function TransactionsPanel() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const actor = await getPaymentActor();
      const result = await actor.list_transactions();
      if ("Ok" in result) {
        setTransactions(result.Ok);
        setError(null);
      } else {
        setError(result.Err);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await poll();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void poll();
    timer.current = setInterval(() => void poll(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [poll]);

  const filtered = transactions.filter((tx) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      tx.reference.toLowerCase().includes(q) ||
      tx.merchant_reference.toLowerCase().includes(q) ||
      tx.transaction_id.toLowerCase().includes(q) ||
      tx.order_id.toString().includes(q)
    );
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reference, order…"
          className="w-64 rounded border border-c-line bg-c-surface px-3 py-1.5 text-xs text-c-text placeholder:text-c-faint focus:border-c-accent focus:outline-none"
        />
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          Refresh
        </Button>
        <span className="text-[10px] text-c-faint">
          {filtered.length} of {transactions.length} transaction{transactions.length === 1 ? "" : "s"} · polled every {POLL_MS / 1000}s
        </span>
      </div>

      {error && (
        <p className="rounded border border-c-danger/30 bg-c-danger-a22 px-3 py-2 text-xs text-c-danger">
          {error}
        </p>
      )}

      {!error && loaded && transactions.length === 0 && (
        <p className="rounded border border-c-line bg-c-surface px-3 py-6 text-center text-xs text-c-faint">
          No transactions yet - charges created by the project's order modules appear here.
        </p>
      )}

      {filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-c-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-c-line bg-c-surface text-[10px] uppercase tracking-wide text-c-faint">
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Merchant ref</th>
                <th className="px-3 py-2 font-medium">Provider reference</th>
                <th className="px-3 py-2 font-medium">Transaction</th>
                <th className="px-3 py-2 font-medium">Owner notified</th>
                <th className="px-3 py-2 font-medium">Checkout</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr key={tx.reference} className="border-b border-c-line/60 last:border-0 hover:bg-c-surface2/50">
                  <td className="whitespace-nowrap px-3 py-2 text-c-muted">{formatTimestamp(tx.created_at)}</td>
                  <td className="px-3 py-2"><StatusBadge status={tx.status} /></td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{formatAmount(tx.amount_minor, tx.currency)}</td>
                  <td className="px-3 py-2 font-mono text-c-muted">#{tx.order_id.toString()}</td>
                  <td className="max-w-[160px] truncate px-3 py-2 font-mono text-c-muted" title={tx.merchant_reference}>
                    {tx.merchant_reference}
                  </td>
                  <td className="px-3 py-2 font-mono text-c-muted" title={tx.reference}>
                    {shortRef(tx.reference)}
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2 font-mono text-c-faint" title={tx.transaction_id}>
                    {tx.transaction_id || "—"}
                  </td>
                  <td className="px-3 py-2 text-c-faint">
                    {tx.owner_notified ? <Bell size={13} className="text-c-ok" /> : <BellOff size={13} />}
                  </td>
                  <td className="px-3 py-2">
                    {tx.checkout_url ? (
                      <a
                        href={tx.checkout_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-c-accent hover:underline"
                      >
                        Open <ExternalLink size={11} />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
