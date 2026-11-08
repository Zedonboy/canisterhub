import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Wallet as WalletIcon, RefreshCw, Loader2, TriangleAlert,
  CreditCard, TrendingDown, Clock, ChevronRight, ChevronDown, Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Table, TableHead, TableBody, Th, Tr, Td } from "@/components/ui/Table";
import { toast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { WalletPanel } from "@/components/WalletPanel";
import { TopUpCyclesButton } from "@/components/TopUpCycles";
import {
  formatTokenAmount, parseTokenAmount,
  getCyclesMintTransactions, CYCLES_LEDGER_CANISTER_ID, type TokenBalance,
  type CyclesMintTransaction,
} from "@/lib/wallet";
import { Principal } from "@icp-sdk/core/principal";
import { topUpCanister } from "@/lib/runtime";
import { getAllCanisterStats, totalBurnRatePerDay, type CanisterStats } from "@/lib/canisterStats";
import { CANISTER_KIND_LABELS, type CanisterKind } from "@/lib/backend";
import { ACTIVE_PROJECT, formatCycles } from "@/lib/mock-data";
import type { ProjectContext } from "@/components/layout/AppShell";

/** Real `withdraw` (see `lib/runtime.ts::topUpCanister`) - moves cycles
 * straight from the signed-in principal's own Cycles Ledger balance into
 * one specific canister, opened from that canister's own "Top Up" row
 * action in the Usage Breakdown drilldown rather than the project-wide
 * "Top Up Cycles" dialog, which converts ICP into the caller's Cycles
 * Ledger balance through the CMC. Amount is entered in the same units the
 * Cycles Ledger token row already shows (`cyclesToken.decimals`), not raw
 * integer cycles. */
function TopUpCanisterDialog({
  target,
  network,
  cyclesToken,
  onClose,
  onDone,
}: {
  target: { id: string; name: string } | null;
  network: string;
  cyclesToken: TokenBalance | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const decimals = cyclesToken?.decimals ?? 12;

  useEffect(() => {
    if (target) setAmount("");
  }, [target]);

  if (!target) return null;

  const submit = async () => {
    let raw: bigint;
    try {
      raw = parseTokenAmount(amount, decimals);
      if (raw <= 0n) throw new Error("amount must be greater than zero");
    } catch (e) {
      toast.error("Check the amount", e instanceof Error ? e.message : String(e));
      return;
    }

    setBusy(true);
    try {
      await topUpCanister(target.id, network, raw);
      toast.success("Topped up", `${formatTokenAmount(raw, decimals)} ${cyclesToken?.symbol ?? "cycles"} sent to ${target.name}.`);
      onDone();
    } catch (e) {
      toast.error("Top-up failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={() => !busy && onClose()}>
      <DialogHeader title={`Top Up ${target.name}`} onClose={busy ? undefined : onClose} />
      <DialogContent className="space-y-3">
        <div className="text-[11px] text-[#4a5568] font-mono truncate">{target.id}</div>
        <div>
          <Label htmlFor="topup-amount">Amount</Label>
          <div className="flex items-center gap-2">
            <Input id="topup-amount" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-xs text-[#4a5568] font-mono flex-shrink-0">{cyclesToken?.symbol ?? "cycles"}</span>
          </div>
        </div>
        {cyclesToken?.balance != null && (
          <p className="text-[11px] text-[#4a5568]">
            Your Cycles Ledger balance: {formatTokenAmount(cyclesToken.balance, decimals)} {cyclesToken.symbol}
          </p>
        )}
        <p className="text-[11px] text-[#ffab40]">Deposited directly into this canister's own cycles balance - irreversible, same as any other withdrawal.</p>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !amount.trim()} className="gap-1.5">
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? "Sending…" : "Top Up"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One service-level row in the Usage Breakdown table - every canister in
 * `job.canisters` grouped by its `CanisterKind` (the real project-side
 * "service" grouping - see `backend.ts::CANISTER_KIND_LABELS`), with
 * per-group totals derived from the exact same `getAllCanisterStats` result
 * `WalletPage` already fetched once for the Burn Rate summary card - no
 * second `canister_status` round-trip for the same canisters. */
interface ServiceGroup {
  kind: CanisterKind;
  canisters: Array<{ name: string; stats: CanisterStats }>;
  totalCycles: number;
  knownCycles: boolean;
  totalBurnPerDay: number;
}

function groupByService(job: NonNullable<ProjectContext["job"]>, stats: Record<string, CanisterStats>): ServiceGroup[] {
  const byKind = new Map<CanisterKind, ServiceGroup>();
  for (const [name, canisterStats] of Object.entries(stats)) {
    const kind = job.canisters[name]?.kind ?? "other";
    let group = byKind.get(kind);
    if (!group) {
      group = { kind, canisters: [], totalCycles: 0, knownCycles: false, totalBurnPerDay: 0 };
      byKind.set(kind, group);
    }
    group.canisters.push({ name, stats: canisterStats });
    if (canisterStats.cycles !== null) {
      group.totalCycles += canisterStats.cycles;
      group.knownCycles = true;
    }
    group.totalBurnPerDay += canisterStats.idle_cycles_burned_per_day ?? 0;
  }
  return Array.from(byKind.values()).sort((a, b) => b.totalCycles - a.totalCycles);
}

/** One service group's row, plus its individual canisters revealed by the
 * chevron toggle - "a pulldown that list[s] the individual canister[s] that
 * make up a service" (the user's own framing). Each canister row also gets
 * its own "Top Up" action - the user's own instruction ("add action button
 * to topup the individual canisters") - rather than only a project-wide
 * top-up. */
function ServiceRow({
  group,
  onTopUp,
}: {
  group: ServiceGroup;
  onTopUp: (canister: { id: string; name: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Tr className="cursor-pointer hover:bg-[#131929]" onClick={() => setExpanded((v) => !v)}>
        <Td className="font-medium text-[#e2e8f0]">
          <span className="inline-flex items-center gap-1.5">
            {expanded ? <ChevronDown size={13} className="text-[#4a5568]" /> : <ChevronRight size={13} className="text-[#4a5568]" />}
            {CANISTER_KIND_LABELS[group.kind]}
            <span className="text-[10px] text-[#4a5568] font-mono">({group.canisters.length})</span>
          </span>
        </Td>
        <Td className="font-mono text-[#8892a4]">{group.knownCycles ? formatCycles(group.totalCycles) : "—"}</Td>
        <Td className="font-mono text-[#8892a4]">{formatCycles(group.totalBurnPerDay)}/day</Td>
        <Td />
      </Tr>
      {expanded && group.canisters.map(({ name, stats }) => (
        <Tr key={name} className="bg-[#0a0e1a66]">
          <Td className="pl-8">
            <div className="text-xs text-[#e2e8f0]">{name}</div>
            <div className="text-[10px] text-[#4a5568] font-mono truncate max-w-[14rem]">{stats.id}</div>
          </Td>
          <Td className="font-mono text-xs text-[#8892a4]">
            {stats.cycles !== null ? formatCycles(stats.cycles) : stats.error ? "unavailable" : "—"}
          </Td>
          <Td className="font-mono text-xs text-[#8892a4]">
            {stats.idle_cycles_burned_per_day !== null ? `${formatCycles(stats.idle_cycles_burned_per_day)}/day` : "—"}
          </Td>
          <Td>
            <Button variant="ghost" size="sm" className="gap-1 text-[#00d4ff] hover:bg-[#00d4ff11]" onClick={() => onTopUp({ id: stats.id, name })}>
              <Zap size={12} /> Top Up
            </Button>
          </Td>
        </Tr>
      ))}
    </>
  );
}

/** The IC API boundary rejects EVERY signed call with HTTP 400 once the
 * sign-in session delegation expires (the 400 body literally says
 * "Invalid delegation expiry: Specified sender delegation has expired") -
 * balances and mint history fail identically, so the page should say
 * "sign in again" instead of looking broken. Verified against ic0.app
 * with an intentionally expired delegation. */
function isSessionExpiryError(message: string | undefined): boolean {
  return !!message && (message.includes("delegation has expired") || message.includes("Invalid delegation"));
}

/** "displays Wallet Token balance...like a Tokens balance screen like
 * Metamask UI" (the user's own framing), merged with the former Billing
 * page's cycles/top-up section (the user's own instruction: "Billing and
 * Wallet page should be merged into one page") - they were always
 * overlapping views of the same signed-in principal's real Cycles Ledger
 * balance, just fetched twice; this page fetches `getTokenBalances` once
 * and the billing section below picks the Cycles Ledger's own entry
 * (`CYCLES_LEDGER_CANISTER_ID`) out of that same list rather than a second
 * `icrc1_balance_of` call.
 *
 * Send/Approve/Add Token sit together as one row of top-level actions
 * (MetaMask's own layout); Send and Approve open a shared dialog that
 * picks its own token via a dropdown. The Cycles Consumption chart, Cycles
 * Balance card, and cycles alert box all later moved to `Analytics.tsx`
 * (the user's own instructions) - this page keeps the summary cards,
 * Usage Breakdown (now real, grouped by service with a real per-canister
 * top-up action), and Top-Up History (real cycles mints read through the
 * Cycles Ledger's own ICRC-1 index, not sample data). The project-wide
 * ICP-to-cycles mint and balance/burn-rate values are real. */
export default function WalletPage() {
  const { job } = useOutletContext<ProjectContext>();
  const { principal } = useAuth();
  const [tokens, setTokens] = useState<TokenBalance[] | null>(null);
  const [walletReloadSignal, setWalletReloadSignal] = useState(0);
  const [canisterStats, setCanisterStats] = useState<Record<string, CanisterStats> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [topUpTarget, setTopUpTarget] = useState<{ id: string; name: string } | null>(null);
  // Real Top-Up History state - cycles mints credited to the signed-in
  // principal's default Cycles Ledger account (see the effect below).
  const [mints, setMints] = useState<CyclesMintTransaction[] | null>(null);
  const [mintsError, setMintsError] = useState<string | null>(null);

  const network = job?.network ?? "ic";

  // One `canister_status` round-trip per canister, fetched once here and
  // reused by both the Burn Rate summary card and the Usage Breakdown table
  // below - neither re-fetches it, per the user's own instruction ("the
  // page makes only 1 request, dont make redundant request for the same
  // data").
  const loadStats = useCallback(() => {
    if (!job) return;
    setStatsLoading(true);
    getAllCanisterStats(job.canisters, network)
      .then(setCanisterStats)
      .finally(() => setStatsLoading(false));
  }, [job, network]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const refreshAll = () => {
    setWalletReloadSignal((n) => n + 1);
    loadStats();
  };

  // The real current balance - the signed-in principal's own Cycles Ledger
  // entry in `tokens` above (see this component's own doc comment), not a
  // second fetch. `cyclesMax` stays mock: there's no real capacity-ceiling
  // data source anywhere in this project yet, so "% capacity" remains the
  // same disclosed estimate it always was - the balance and the burn rate
  // below it are both real.
  const cyclesToken = tokens?.find((t) => t.id === CYCLES_LEDGER_CANISTER_ID) ?? null;
  const cyclesRaw = cyclesToken?.balance ?? null;
  const cyclesBalance = cyclesRaw !== null ? Number(cyclesRaw) : 0;

  const project = ACTIVE_PROJECT;
  // Real: every controlled canister's own `idle_cycles_burned_per_day`,
  // summed from the one `canisterStats` fetch above (see `loadStats`'s own
  // doc comment) - not a mock constant.
  const burnRatePerDay = canisterStats ? totalBurnRatePerDay(canisterStats) : 0;
  const daysRemaining = burnRatePerDay > 0 ? Math.floor(cyclesBalance / burnRatePerDay) : null;
  const pct = Math.round((cyclesBalance / project.cyclesMax) * 100);

  const serviceGroups = canisterStats && job ? groupByService(job, canisterStats) : [];

  const summaryCards = [
    {
      label: "Current Balance",
      value: cyclesRaw !== null ? formatCycles(cyclesBalance) : "—",
      sub: tokens === null
        ? "Loading…"
        : cyclesToken?.error
          ? isSessionExpiryError(cyclesToken.error)
            ? <span className="inline-flex items-center gap-1 text-[#ffab40]"><TriangleAlert size={11} /> Session expired - sign in again</span>
            : <span className="inline-flex items-center gap-1 text-[#ffab40]"><TriangleAlert size={11} /> Balance unavailable</span>
          : `${pct}% capacity`,
      icon: () => <CreditCard size={16} />,
      variant: cyclesRaw === null ? "gray" : pct > 50 ? "green" : pct > 20 ? "amber" : "red",
    },
    {
      label: "Burn Rate",
      value: canisterStats ? `${formatCycles(burnRatePerDay)}/day` : "—",
      sub: canisterStats ? "sum of controlled canisters" : "Loading…",
      icon: () => <TrendingDown size={16} />,
      variant: "gray",
    },
    {
      label: "Days Remaining",
      value: cyclesRaw !== null && daysRemaining !== null ? `~${daysRemaining}d` : "—",
      sub: "at current burn rate",
      icon: () => <Clock size={16} />,
      variant: daysRemaining === null ? "gray" : daysRemaining > 30 ? "green" : daysRemaining > 7 ? "amber" : "red",
    },
  ];

  // Real Top-Up History: cycles mints credited to the signed-in principal's
  // default Cycles Ledger account, read through the ledger's own ICRC-1
  // index (see `getCyclesMintTransactions`'s own doc comment). Reloads on
  // the same signal as the balances above, so a mint confirmed by the
  // dialog below appears in the list immediately.
  useEffect(() => {
    if (!principal) {
      setMints(null);
      setMintsError(null);
      return;
    }
    let active = true;
    setMintsError(null);
    getCyclesMintTransactions(network, Principal.fromText(principal))
      .then((result) => {
        if (active) setMints(result);
      })
      .catch((error) => {
        if (!active) return;
        setMints([]);
        setMintsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [principal, network, walletReloadSignal]);

  return (
    <div className="p-4 sm:p-6 space-y-6 animate-fade-in max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <WalletIcon size={18} className="text-[#00d4ff]" /> Wallet &amp; Billing
          </h2>
          <p className="text-sm text-[#4a5568] mt-1">Real on-chain token balances for your signed-in identity, and this project's cycles.</p>
        </div>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={refreshAll} disabled={statsLoading}>
          <RefreshCw size={13} className={statsLoading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Wallet column - same shared panel `Account.tsx` renders, per
            the user's own instruction ("use same wallet UI in Billing
            page for Account page"). `onTokensChange` mirrors its fetch
            into this page's own `tokens` state for the Billing column's
            Cycles Ledger balance below, rather than a second fetch. */}
        <WalletPanel network={network} reloadSignal={walletReloadSignal} onTokensChange={setTokens} />

        {/* Billing column */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider flex items-center gap-1.5">
              <CreditCard size={12} /> Billing &amp; Cycles
            </h3>
            {/* The shared project-wide ICP-to-cycles mint dialog lives in
                `TopUpCyclesButton` (also rendered by the Account page) - the
                "Top Up Cycles" flow is identical on both pages. */}
            <TopUpCyclesButton network={network} onMinted={() => setWalletReloadSignal((n) => n + 1)} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {summaryCards.map((card) => (
              <Card key={card.label} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[#4a5568]">{card.icon()}</span>
                  <Badge variant={card.variant as "green" | "amber" | "red" | "gray"}>
                    {card.variant === "green" ? "good" : card.variant === "amber" ? "warn" : card.variant === "red" ? "low" : "—"}
                  </Badge>
                </div>
                <div className="text-2xl font-bold text-[#e2e8f0] font-mono">{card.value}</div>
                <div className="text-xs text-[#4a5568] mt-1">{card.label}</div>
                <div className="text-[10px] text-[#4a5568]">{card.sub}</div>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Usage Breakdown</CardTitle>
              <span className="text-[10px] text-[#4a5568]">Click a service to see its canisters</span>
            </CardHeader>
            <CardContent className="p-0">
              {!canisterStats ? (
                <p className="text-xs text-[#4a5568] p-4">{statsLoading ? "Loading canister status…" : "No data yet."}</p>
              ) : serviceGroups.length === 0 ? (
                <p className="text-xs text-[#4a5568] p-4">This project has no canisters deployed yet.</p>
              ) : (
                <Table>
                  <TableHead>
                    <tr><Th>Service</Th><Th>Cycles Balance</Th><Th>Burn Rate</Th><Th>Actions</Th></tr>
                  </TableHead>
                  <TableBody>
                    {serviceGroups.map((group) => (
                      <ServiceRow key={group.kind} group={group} onTopUp={setTopUpTarget} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top-Up History</CardTitle>
              <span className="text-[10px] text-[#4a5568]">Cycles minted into your Cycles Ledger balance</span>
            </CardHeader>
            <CardContent className="p-0">
              {mintsError ? (
                <p className="text-xs text-[#ffab40] p-4">
                  {isSessionExpiryError(mintsError)
                    ? "Your session has expired - sign in again to see top-up history."
                    : `Couldn't load mint history: ${mintsError}`}
                </p>
              ) : mints === null ? (
                <p className="text-xs text-[#4a5568] p-4">Loading mint history…</p>
              ) : mints.length === 0 ? (
                <p className="text-xs text-[#4a5568] p-4">
                  {principal ? "No cycle mints yet for this identity." : "Sign in to see top-up history."}
                </p>
              ) : mints.map((mint) => (
                <div key={mint.blockIndex.toString()} className="flex items-center justify-between px-4 py-2.5 border-b border-[#162035] last:border-0 text-xs">
                  <div>
                    <div className="font-mono text-[#e2e8f0]">#{mint.blockIndex.toString()}</div>
                    <div className="text-[#4a5568]">
                      {new Date(Number(mint.timestampNanos / 1_000_000n)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[#e2e8f0]">{formatTokenAmount(mint.minted, 12)}</div>
                    <div className="text-[#4a5568] font-mono">cycles</div>
                  </div>
                  <Badge variant="green">minted</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <TopUpCanisterDialog
        target={topUpTarget}
        network={network}
        cyclesToken={cyclesToken}
        onClose={() => setTopUpTarget(null)}
        onDone={() => { setTopUpTarget(null); setWalletReloadSignal((n) => n + 1); loadStats(); }}
      />
    </div>
  );
}
