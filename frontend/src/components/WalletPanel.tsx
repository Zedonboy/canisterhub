import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet as WalletIcon, Copy, Check, Coins, Plus, Send, Download, ShieldCheck, X, Loader2, TriangleAlert } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import {
  getTokenBalances, formatTokenAmount, parseTokenAmount, addToken, removeToken,
  transferToken, approveToken, getTokenFee, type TokenBalance,
} from "@/lib/wallet";

/** One token's own accent color, cycling through a small fixed palette by
 * symbol - purely cosmetic (a colored initial badge, MetaMask-style),
 * nothing about the real balance data depends on it. */
function tokenColor(symbol: string): { fg: string; bg: string; border: string } {
  const palette = [
    { fg: "#00d4ff", bg: "#00d4ff1a", border: "#00d4ff33" },
    { fg: "#c084fc", bg: "#c084fc1a", border: "#c084fc33" },
    { fg: "#ffab40", bg: "#ffab401a", border: "#ffab4033" },
    { fg: "#00e676", bg: "#00e6761a", border: "#00e67633" },
  ];
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function TokenRow({ token, onRemove }: { token: TokenBalance; onRemove: () => void }) {
  const color = tokenColor(token.symbol);
  const usable = token.balance !== null;
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[#1e2d47] last:border-0 group">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-semibold text-sm"
        style={{ color: color.fg, backgroundColor: color.bg, border: `1px solid ${color.border}` }}
      >
        {token.symbol.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[#e2e8f0] truncate">{token.name}</div>
        <div className="text-[11px] text-[#4a5568] font-mono">{token.symbol}</div>
      </div>
      <div className="text-right flex-shrink-0">
        {usable ? (
          <>
            <div className="text-sm font-medium text-[#e2e8f0] font-mono">{formatTokenAmount(token.balance!, token.decimals)}</div>
            <div className="text-[10px] text-[#4a5568]">{token.symbol}</div>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-[#ffab40]" title="Balance unavailable">
            <TriangleAlert size={14} />
          </span>
        )}
      </div>
      {token.custom && (
        <button onClick={onRemove} className="p-1.5 rounded text-[#4a5568] hover:text-[#ff5252] hover:bg-[#ff525211] transition-colors opacity-60 sm:opacity-0 sm:group-hover:opacity-100 flex-shrink-0" title="Stop tracking">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** Real `icrc1_transfer` (mode "send") / `icrc2_approve` (mode "approve") -
 * a single dialog for either, opened from the top-level Send/Approve
 * buttons rather than a specific token row, so it picks its own token via
 * the dropdown below (only ones with a real, known balance are selectable -
 * nothing usable to send *from* otherwise). */
function TransferDialog({ mode, tokens, network, onClose, onDone }: { mode: "send" | "approve" | null; tokens: TokenBalance[]; network: string; onClose: () => void; onDone: () => void }) {
  const usableTokens = useMemo(() => tokens.filter((t) => t.balance !== null), [tokens]);
  const [tokenId, setTokenId] = useState<string>("");
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    setTokenId(usableTokens[0]?.id ?? "");
    setTarget("");
    setAmount("");
    setFee(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const token = usableTokens.find((t) => t.id === tokenId);

  useEffect(() => {
    if (!token) return;
    getTokenFee(token.id, network).then(setFee);
  }, [token, network]);

  if (!mode) return null;
  const isSend = mode === "send";

  const submit = async () => {
    if (!token) return;
    let raw: bigint;
    let targetPrincipal: string;
    try {
      raw = parseTokenAmount(amount, token.decimals);
      if (raw <= 0n) throw new Error("amount must be greater than zero");
      targetPrincipal = Principal.fromText(target.trim()).toText();
    } catch (e) {
      toast.error("Check the form", e instanceof Error ? e.message : String(e));
      return;
    }

    setBusy(true);
    try {
      if (isSend) {
        await transferToken(token.id, network, targetPrincipal, raw);
        toast.success("Sent", `${formatTokenAmount(raw, token.decimals)} ${token.symbol} sent.`);
      } else {
        await approveToken(token.id, network, targetPrincipal, raw);
        toast.success("Approved", `${targetPrincipal.slice(0, 10)}… can now move up to ${formatTokenAmount(raw, token.decimals)} ${token.symbol}.`);
      }
      onDone();
    } catch (e) {
      toast.error(isSend ? "Send failed" : "Approve failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={() => !busy && onClose()}>
      <DialogHeader title={isSend ? "Send" : "Approve"} onClose={busy ? undefined : onClose} />
      <DialogContent className="space-y-3">
        {usableTokens.length === 0 ? (
          <p className="text-sm text-[#4a5568]">No token has a usable balance right now - nothing to {mode} from.</p>
        ) : (
          <>
            <div>
              <Label htmlFor="wallet-token">Token</Label>
              <Select
                id="wallet-token"
                value={tokenId}
                onChange={setTokenId}
                disabled={busy}
                options={usableTokens.map((t) => ({
                  value: t.id,
                  label: `${t.symbol} — ${formatTokenAmount(t.balance!, t.decimals)} available`,
                }))}
              />
            </div>
            <div>
              <Label htmlFor="wallet-target">{isSend ? "Recipient principal" : "Spender principal"}</Label>
              <Input id="wallet-target" placeholder="e.g. rdmx6-jaaaa-aaaaa-aaadq-cai" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} className="font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="wallet-amount">Amount</Label>
              <div className="flex items-center gap-2">
                <Input id="wallet-amount" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
                <span className="text-xs text-[#4a5568] font-mono flex-shrink-0">{token?.symbol}</span>
              </div>
            </div>
            {token && (
              <p className="text-[11px] text-[#4a5568]">
                Balance: {formatTokenAmount(token.balance!, token.decimals)} {token.symbol}
                {isSend && fee !== null && ` · Network fee: ${formatTokenAmount(fee, token.decimals)} ${token.symbol}`}
              </p>
            )}
            {!isSend && <p className="text-[11px] text-[#ffab40]">This lets the spender move up to this amount on your behalf later - it doesn't send anything now.</p>}
          </>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !token || !target.trim() || !amount.trim()} className="gap-1.5">
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? (isSend ? "Sending…" : "Approving…") : isSend ? "Send" : "Approve"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AddTokenDialog({ open, network, onClose, onAdded }: { open: boolean; network: string; onClose: () => void; onAdded: () => void }) {
  const [canisterId, setCanisterId] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open) setCanisterId("");
  }, [open]);

  const submit = async () => {
    let id: string;
    try {
      id = Principal.fromText(canisterId.trim()).toText();
    } catch {
      toast.error("Not a valid canister id");
      return;
    }
    setAdding(true);
    try {
      const { symbol, name } = await addToken(id, network);
      toast.success("Token added", `${name} (${symbol}) is now tracked.`);
      onAdded();
      onClose();
    } catch (e) {
      toast.error("Couldn't add this token", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !adding && onClose()}>
      <DialogHeader title="Add a token" onClose={adding ? undefined : onClose} />
      <DialogContent className="space-y-3">
        <div>
          <Label htmlFor="token-canister-id">ICRC-1 ledger canister id</Label>
          <Input id="token-canister-id" placeholder="e.g. ryjl3-tyaaa-aaaaa-aaaba-cai" value={canisterId} onChange={(e) => setCanisterId(e.target.value)} disabled={adding} className="font-mono text-xs" />
        </div>
        <p className="text-[11px] text-[#4a5568]">Checked live against the real canister (a real `icrc1_symbol` call) before it's added to your watchlist.</p>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={adding}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={adding || !canisterId.trim()} className="gap-1.5">
          {adding && <Loader2 size={13} className="animate-spin" />}
          {adding ? "Checking…" : "Add Token"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Just your own principal, large and copyable - "Receive" in a wallet
 * UI is never an action against a canister, just showing the address
 * whoever's paying you needs. */
function ReceiveDialog({ open, principal, onClose }: { open: boolean; principal: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!principal) return;
    await navigator.clipboard.writeText(principal);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader title="Receive" onClose={onClose} />
      <DialogContent className="space-y-3">
        <p className="text-xs text-[#4a5568]">Share this principal with whoever's sending you tokens or cycles.</p>
        <div className="p-3 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg">
          <div className="text-sm font-mono text-[#e2e8f0] break-all">{principal ?? "Sign in to see your principal"}</div>
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="primary" size="sm" className="gap-1.5" onClick={copy} disabled={!principal}>
          {copied ? <Check size={13} className="text-[#0a0e1a]" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy principal"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The real "Wallet column" (principal + Send/Receive/Approve/Add Token +
 * Tokens list) - shared verbatim between `Wallet.tsx` (that page's own
 * Billing &amp; Cycles column sits alongside this) and `Account.tsx` (the
 * user's own instruction: "use same wallet UI in Billing page for Account
 * page"), so both render the exact same component instead of two copies
 * that could drift. Fetches `getTokenBalances` itself - `onTokensChange`
 * lets a caller that also needs the result for its own unrelated
 * calculations (e.g. `Wallet.tsx`'s Cycles Ledger balance for its Billing
 * summary cards) mirror it into its own state without a second, redundant
 * fetch; `reloadSignal` lets that same caller's own page-level "Refresh"
 * button force this panel to reload too (bump the number). */
export function WalletPanel({
  network,
  reloadSignal,
  onTokensChange,
}: {
  network: string;
  reloadSignal?: number;
  onTokensChange?: (tokens: TokenBalance[] | null) => void;
}) {
  const { principal } = useAuth();
  const [tokens, setTokens] = useState<TokenBalance[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddToken, setShowAddToken] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [transferMode, setTransferMode] = useState<"send" | "approve" | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (!principal) return;
    setLoadError(null);
    getTokenBalances(Principal.fromText(principal), network)
      .then((result) => {
        setTokens(result);
        onTokensChange?.(result);
      })
      .catch((error) => {
        console.error("Could not load wallet balances", error);
        setLoadError("Balances are temporarily unavailable. Use Refresh to try again.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, network]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, reloadSignal]);

  const copyAddress = async () => {
    if (!principal) return;
    await navigator.clipboard.writeText(principal);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleRemove = async (token: TokenBalance) => {
    try {
      await removeToken(token.id, network);
      toast.success("Removed", `${token.symbol} is no longer tracked.`);
      load();
    } catch (e) {
      toast.error("Couldn't remove this token", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider flex items-center gap-1.5">
        <WalletIcon size={12} /> Wallet
      </h3>

      <Card>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] text-[#4a5568] uppercase tracking-wider mb-1">Your Principal</div>
            <div className="text-xs font-mono text-[#e2e8f0] truncate">{principal ?? "—"}</div>
          </div>
          <Button variant="secondary" size="sm" className="gap-1.5 flex-shrink-0" onClick={copyAddress} disabled={!principal}>
            {copied ? <Check size={13} className="text-[#00e676]" /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" size="sm" className="gap-1.5 flex-1" onClick={() => setTransferMode("send")}>
          <Send size={14} /> Send
        </Button>
        <Button variant="secondary" size="sm" className="gap-1.5 flex-1" onClick={() => setShowReceive(true)}>
          <Download size={14} /> Receive
        </Button>
        <Button variant="secondary" size="sm" className="gap-1.5 flex-1" onClick={() => setTransferMode("approve")}>
          <ShieldCheck size={14} /> Approve
        </Button>
        <Button variant="secondary" size="sm" className="gap-1.5 flex-1" onClick={() => setShowAddToken(true)}>
          <Plus size={14} /> Add Token
        </Button>
      </div>

      <div>
        <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Coins size={12} /> Tokens
        </h3>
        <Card className="overflow-hidden">
          {loadError && (
            <p className="inline-flex items-center gap-2 text-sm text-[#ffab40] p-4">
              <TriangleAlert size={14} /> {loadError}
            </p>
          )}
          {!loadError && tokens === null && <p className="text-sm text-[#4a5568] p-4">Loading balances…</p>}
          {!loadError && tokens !== null && tokens.map((t) => (
            <TokenRow key={t.id} token={t} onRemove={() => handleRemove(t)} />
          ))}
        </Card>
      </div>

      <AddTokenDialog open={showAddToken} network={network} onClose={() => setShowAddToken(false)} onAdded={load} />
      <ReceiveDialog open={showReceive} principal={principal} onClose={() => setShowReceive(false)} />
      <TransferDialog mode={transferMode} tokens={tokens ?? []} network={network} onClose={() => setTransferMode(null)} onDone={() => { setTransferMode(null); load(); }} />
    </div>
  );
}
