import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Zap, User, LogOut, RefreshCw } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CanisterID } from "@/components/CanisterID";
import { ToastProvider } from "@/components/Toast";
import { Footer } from "@/components/layout/Footer";
import { WalletPanel } from "@/components/WalletPanel";
import { TopUpCyclesButton } from "@/components/TopUpCycles";
import { useAuth } from "@/lib/auth";
import { runtimeNetwork } from "@/lib/canisterEnv";

/** `/account` - a project-agnostic home for the signed-in identity itself,
 * reached from the Dashboard header's "Wallet" button (the user's own
 * framing: "its more like account page, with Wallet UI section"). The
 * Wallet section is the exact same `WalletPanel` `Wallet.tsx` renders in
 * its own "Wallet & Billing" page (the user's own instruction: "use same
 * wallet UI in Billing page for Account page") - Send/Receive/Approve/Add
 * Token and all, just driven by `runtimeNetwork()` instead of a specific
 * project's `job.network`, since there's no project here at all. The
 * Profile card also carries the same shared `TopUpCyclesButton` the Wallet
 * & Billing page renders (the user's own instruction: "use same flow as
 * the Wallet&Billing"), right after Sign Out. */
export default function Account() {
  const navigate = useNavigate();
  const { status, principal, signOut } = useAuth();
  const [reloadSignal, setReloadSignal] = useState(0);

  const network = runtimeNetwork();

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <header className="h-12 flex items-center px-4 sm:px-6 border-b border-[#1e2d47] bg-[#0a0e1a] flex-shrink-0">
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-2 text-[#4a5568] hover:text-[#e2e8f0] transition-colors text-sm"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div className="flex items-center gap-2 ml-4 pl-4 border-l border-[#1e2d47]">
          <div className="w-5 h-5 bg-[#00d4ff] rounded flex items-center justify-center">
            <Zap size={10} className="text-[#0a0e1a]" fill="currentColor" />
          </div>
          <span className="text-sm font-semibold text-[#e2e8f0]">Canisterhub</span>
          <span className="text-[#4a5568]">/</span>
          <span className="text-sm text-[#e2e8f0]">Account</span>
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 sm:px-6 py-10 space-y-6">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Profile</CardTitle>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setReloadSignal((n) => n + 1)}>
              <RefreshCw size={13} /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#00d4ff22] border border-[#00d4ff44] flex items-center justify-center flex-shrink-0">
                <User size={18} className="text-[#00d4ff]" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-[#e2e8f0]">
                  {status === "authenticated" ? "Signed in" : "Not signed in"}
                </div>
                {principal ? <CanisterID id={principal} className="text-xs" /> : (
                  <div className="text-xs text-[#4a5568]">2vxsx-fae (anonymous)</div>
                )}
              </div>
            </div>
            {status === "authenticated" && (
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" className="gap-1.5" onClick={handleSignOut}>
                  <LogOut size={13} /> Sign Out
                </Button>
                {/* Same ICP-to-cycles mint flow as the Wallet & Billing page
                    (`TopUpCyclesButton` is shared by both) - a successful
                    mint bumps `reloadSignal` so the WalletPanel balances
                    below refresh, same as that page's own refresh. */}
                <TopUpCyclesButton network={network} onMinted={() => setReloadSignal((n) => n + 1)} />
              </div>
            )}
          </CardContent>
        </Card>

        <WalletPanel network={network} reloadSignal={reloadSignal} />
      </main>

      <Footer />

      <ToastProvider />
    </div>
  );
}
