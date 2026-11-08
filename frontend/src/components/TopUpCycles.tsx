import { useEffect, useRef, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { toast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { formatTokenAmount, parseTokenAmount, getCyclesMintingRate, mintCyclesFromIcp } from "@/lib/wallet";

/** The "Top Up Cycles" action + dialog shared by the Wallet & Billing page
 * and the Account page (the user's own instruction: "use same flow as the
 * Wallet&Billing") - converts ICP into the signed-in principal's Cycles
 * Ledger balance through the Cycles Minting Canister
 * (`lib/wallet.ts::mintCyclesFromIcp`), then lets the host refresh its
 * balances via `onMinted`. Renders its own button next to wherever the host
 * places it; the dialog chrome and mint logic are identical on both pages. */
export function TopUpCyclesButton({ network, onMinted }: { network: string; onMinted?: () => void }) {
  const { principal } = useAuth();
  const [show, setShow] = useState(false);
  const [icpAmount, setIcpAmount] = useState("1.0");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [mintRate, setMintRate] = useState<bigint | null>(null);
  const [mintRateError, setMintRateError] = useState<string | null>(null);

  // Conversion rate is only needed while the dialog is open - same lazy
  // fetch the Wallet & Billing page did inline before this was shared.
  useEffect(() => {
    if (!show) return;
    let active = true;
    setMintRate(null);
    setMintRateError(null);
    getCyclesMintingRate(network)
      .then((rate) => {
        if (active) setMintRate(rate);
      })
      .catch((error) => {
        if (active) setMintRateError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [show, network]);

  let amountE8s: bigint | null = null;
  try {
    amountE8s = parseTokenAmount(icpAmount, 8);
    if (amountE8s < 10_000_000n) amountE8s = null;
  } catch {
    amountE8s = null;
  }
  const estimatedCycles = amountE8s !== null && mintRate !== null ? amountE8s * mintRate : null;

  const confirm = async () => {
    if (busyRef.current) return;
    if (amountE8s === null) {
      toast.error("Check the amount", "Enter at least 0.1 ICP with at most 8 decimal places.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await mintCyclesFromIcp(network, amountE8s);
      setShow(false);
      toast.success(
        result.resumed ? "Cycles mint recovered" : "Cycles minted",
        `${formatTokenAmount(result.minted, 12)} cycles deposited to ${principal}.`
      );
      onMinted?.();
    } catch (error) {
      toast.error("Cycles mint failed", error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setShow(true)} className="gap-1.5">
        <Plus size={13} /> Top Up Cycles
      </Button>

      <Dialog open={show} onClose={() => !busy && setShow(false)}>
        <DialogHeader title="Top Up Cycles" onClose={busy ? undefined : () => setShow(false)} />
        <DialogContent className="space-y-4">
          <div>
            <Label htmlFor="icp-amount">ICP Amount</Label>
            <Input
              id="icp-amount"
              type="number"
              min="0.1"
              step="0.1"
              value={icpAmount}
              onChange={(e) => setIcpAmount(e.target.value)}
              disabled={busy}
            />
            <p className="text-[10px] text-[#4a5568] mt-1">
              {estimatedCycles !== null
                ? `Estimated: ${formatTokenAmount(estimatedCycles, 12)} cycles at the current CMC rate`
                : mintRateError
                  ? `Current CMC rate unavailable: ${mintRateError}`
                  : "Loading the current CMC conversion rate…"}
            </p>
          </div>
          <div className="bg-[#0a0e1a] rounded border border-[#1e2d47] p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-[#4a5568]">Amount</span>
              <span className="text-[#e2e8f0] font-mono">{icpAmount} ICP</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#4a5568]">Estimated cycles</span>
              <span className="text-[#e2e8f0] font-mono">
                {estimatedCycles !== null ? formatTokenAmount(estimatedCycles, 12) : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#4a5568]">Destination</span>
              <span className="text-[#00d4ff] font-mono truncate max-w-[16rem]" title={principal ?? undefined}>
                {principal ?? "Sign in required"}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-[#ffab40]">
            This transfers ICP to the Cycles Minting Canister and irreversibly converts it into your principal's Cycles Ledger balance.
            The current ICP ledger transfer fee is charged in addition.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setShow(false)} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={confirm}
            disabled={busy || !principal || amountE8s === null}
            className="gap-1.5"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? "Minting…" : "Confirm Top-Up"}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
