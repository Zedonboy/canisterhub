import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/Button";
import { Notice, StatusBadge } from "@/components/bits";
import { SignInCard } from "@/components/SignInCard";
import { cancelMyOrder, listMyOrders, type Order } from "@/lib/api";
import { errorText, formatDateTime, formatMoney } from "@/lib/format";
import { navigate } from "@/lib/router";

type Auth = { status: "loading" | "anonymous" | "authenticated"; signIn: () => Promise<void> };

function OrderCard({ order, highlight, onChanged }: { order: Order; highlight: boolean; onChanged: (o: Order) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancellable = order.status === "Pending" || order.status === "AwaitingPayment";
  return (
    <li className={`rounded-xl border bg-c-surface p-4 flex flex-col gap-3 ${highlight ? "border-c-accent" : "border-c-line"}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-semibold">Order #{order.id}</p>
          <p className="text-xs text-c-faint">{formatDateTime(order.createdAt)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>
      <ul className="text-sm flex flex-col gap-1">
        {order.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-2">
            <span className="text-c-muted truncate">{l.quantity} × {l.name}</span>
            <span className="tabular-nums">{formatMoney(l.totalMinor, order.currency)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between font-semibold text-sm pt-2 border-t border-c-line">
        <span>Total · pay on delivery</span>
        <span className="tabular-nums">{formatMoney(order.totalMinor, order.currency)}</span>
      </div>
      <p className="text-xs text-c-faint">Deliver to: {order.address}{order.instructions && ` (${order.instructions})`}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {cancellable && (
        <Button
          variant="danger"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onChanged(await cancelMyOrder(order.id));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Cancelling…" : "Cancel order"}
        </Button>
      )}
    </li>
  );
}

export default function Orders({ auth, placed, onChanged }: { auth: Auth; placed?: number; onChanged: () => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = auth.status === "authenticated";

  const load = () => {
    listMyOrders().then((o) => (setOrders(o), setError(null))).catch((e) => setError(errorText(e)));
  };
  useEffect(() => {
    if (!signedIn) return;
    load();
    const t = setInterval(() => !document.hidden && load(), 20_000);
    return () => clearInterval(t);
  }, [signedIn]);

  if (auth.status === "loading") return null;
  if (!signedIn) return <div className="max-w-md mx-auto w-full"><SignInCard reason="Sign in to see the orders you've placed." onSignIn={auth.signIn} /></div>;

  return (
    <div className="max-w-2xl mx-auto w-full flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">My orders</h1>
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw size={13} /> Refresh</Button>
      </div>
      {placed !== undefined && (
        <Notice tone="success">
          <span className="inline-flex items-center gap-2"><CheckCircle2 size={16} /> Order #{placed} placed. The shop will confirm it shortly.</span>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {orders === null && !error ? (
        <p className="py-10 text-center text-sm text-c-muted">Loading…</p>
      ) : orders && orders.length === 0 ? (
        <div className="py-12 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-c-muted">You haven't placed any orders yet.</p>
          <Button variant="primary" onClick={() => navigate("/")}>Start shopping</Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders?.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              highlight={o.id === placed}
              onChanged={(u) => (setOrders((cur) => cur && cur.map((x) => (x.id === u.id ? u : x))), onChanged())}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
