import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { User, Zap, ChevronDown, Wallet as WalletIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { ProductSearch } from "@/components/ProductSearch";

/** Shared top bar for the two project-agnostic pages that sit above any
 * one project - Dashboard ("Projects") and Marketplace - so they read as
 * one app shell, not two independently-drifting headers (the user's own
 * complaint: "the market and project dashboard supposed to share navbar,
 * why is there ic mainet" - Marketplace had kept its own copy, "IC
 * Mainnet" badge, fake hardcoded profile and all, after Dashboard's own
 * copy was cleaned up). Neither `/project/:id/*` page uses this - those
 * get `Sidebar`/`Header` from `AppShell` instead, a different nav
 * entirely for a different context (inside one project, not across
 * them).
 *
 * Also carries the product search bar itself (the user's own instruction:
 * "the search bar should be placed at the top navbar") - `Dashboard.tsx`'s
 * old hero search was replaced with an AI prompt input instead (see that
 * page's own doc comment), so this is now the only place product search
 * lives. Hidden below `md` - there's no room for it alongside the logo,
 * tabs, Wallet button, and profile menu in a 48px bar on a phone. */
export function TopNav({ active }: { active: "projects" | "marketplace" }) {
  const navigate = useNavigate();
  const [showProfile, setShowProfile] = useState(false);
  const { status, principal, signOut } = useAuth();

  const handleSignOut = async () => {
    setShowProfile(false);
    await signOut();
    navigate("/login");
  };

  return (
    <>
    <header className="h-12 flex items-center gap-3 px-4 sm:px-6 border-b border-[#1e2d47] bg-[#0a0e1a] flex-shrink-0">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate("/dashboard")}>
          <div className="w-6 h-6 bg-[#00d4ff] rounded flex items-center justify-center">
            <Zap size={12} className="text-[#0a0e1a]" fill="currentColor" />
          </div>
          <span className="text-sm font-semibold text-[#e2e8f0]">Canisterhub</span>
        </div>
        <div className="hidden sm:flex items-center gap-1 text-xs ml-2">
          <button
            onClick={() => navigate("/dashboard")}
            className={active === "projects"
              ? "px-2.5 py-1 rounded text-[#00d4ff] bg-[#00d4ff11] border border-[#00d4ff22]"
              : "px-2.5 py-1 rounded text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"}
          >
            Projects
          </button>
          <button
            onClick={() => navigate("/marketplace")}
            className={active === "marketplace"
              ? "px-2.5 py-1 rounded text-[#00d4ff] bg-[#00d4ff11] border border-[#00d4ff22]"
              : "px-2.5 py-1 rounded text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"}
          >
            Marketplace
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 hidden md:flex justify-center">
        {/* Marketplace search disabled for production launch
        <ProductSearch compact />
        */}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
        {/* Notifications: nothing real feeds this yet (no event/activity
            feed anywhere in this codebase) - left out rather than showing
            a permanently-empty bell. */}

        <button
          onClick={() => navigate("/account")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"
        >
          <WalletIcon size={15} />
          <span className="hidden sm:inline">Wallet</span>
        </button>

        <div className="relative">
          <button
            onClick={() => setShowProfile((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-[#131929] transition-colors"
          >
            <div className="w-6 h-6 rounded bg-[#00d4ff22] border border-[#00d4ff44] flex items-center justify-center">
              <User size={12} className="text-[#00d4ff]" />
            </div>
            <ChevronDown size={12} className="text-[#4a5568]" />
          </button>

          {showProfile && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowProfile(false)} />
              <div className="absolute right-0 top-full mt-1 w-52 bg-[#0f1629] border border-[#1e2d47] rounded shadow-xl z-50">
                <div className="px-3 py-2 border-b border-[#1e2d47]">
                  <div className="text-xs text-[#e2e8f0] font-medium">
                    {status === "authenticated" ? "Signed in" : "Not signed in"}
                  </div>
                  <div className="text-[10px] text-[#4a5568] font-mono truncate">{principal ?? "2vxsx-fae (anonymous)"}</div>
                </div>
                <div className="py-1">
                  {status === "authenticated" ? (
                    <button className="w-full text-left px-3 py-2 text-xs text-[#ff5252] hover:bg-[#131929] transition-colors" onClick={handleSignOut}>
                      Sign Out
                    </button>
                  ) : (
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-[#00d4ff] hover:bg-[#131929] transition-colors"
                      onClick={() => { navigate("/login"); setShowProfile(false); }}
                    >
                      Sign In
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>

    {/* The desktop tab row above is `hidden sm:flex` - no room for it next
        to the logo below that width, so phones get this dedicated
        full-width row instead (the user's own report: "in the mobile
        view, there[']s no tab to switch between projects and market"). */}
    <div className="sm:hidden flex items-center gap-1.5 px-3 py-2 border-b border-[#1e2d47] bg-[#0a0e1a] flex-shrink-0">
      <button
        onClick={() => navigate("/dashboard")}
        className={active === "projects"
          ? "flex-1 text-center px-2.5 py-1.5 rounded text-xs text-[#00d4ff] bg-[#00d4ff11] border border-[#00d4ff22]"
          : "flex-1 text-center px-2.5 py-1.5 rounded text-xs text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"}
      >
        Projects
      </button>
      <button
        onClick={() => navigate("/marketplace")}
        className={active === "marketplace"
          ? "flex-1 text-center px-2.5 py-1.5 rounded text-xs text-[#00d4ff] bg-[#00d4ff11] border border-[#00d4ff22]"
          : "flex-1 text-center px-2.5 py-1.5 rounded text-xs text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"}
      >
        Marketplace
      </button>
    </div>
    </>
  );
}
