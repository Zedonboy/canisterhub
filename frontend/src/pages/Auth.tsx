import { useState } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { Shield, ChevronRight, RefreshCw, Sparkles, Fingerprint, KeyRound, Clock3, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { InstallCanisterDialog } from "@/components/InstallCanisterDialog";
import type { ProjectContext } from "@/components/layout/AppShell";
import { listAuthCanisters } from "@/lib/authProfiles";

/** Shown instead of the canister grid while a project has no `auth`
 * canister yet - matches `Overview.tsx`'s own `WelcomeEmptyState` styling.
 * The three feature chips describe what the real `auth` building block
 * actually provides (`packages/auth/auth.did`'s real `Profile`/OAuth
 * surface), not aspirational marketing copy. "Browse Market" opens the same
 * real marketplace install dialog Overview's own empty state uses - a
 * pre-built published item, if one happens to fit, beats writing one from
 * scratch. */
function AuthEmptyState({ onAskAI, onBrowseMarket }: { onAskAI: () => void; onBrowseMarket: () => void }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-14 rounded-xl border border-dashed border-[#1e2d47] bg-[#0d1526]">
      <div className="relative mb-5">
        <div className="absolute inset-0 blur-2xl bg-[#00d4ff22] rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center">
          <Shield size={24} className="text-[#00d4ff]" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">No auth canister yet</h3>
      <p className="text-sm text-[#4a5568] max-w-md mb-5">
        Real user profiles and sign-in for this project - principal-native identity and OAuth (Google, GitHub, or
        any OAuth2 provider) side by side, resolving to one profile either way.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00d4ff0d] border border-[#00d4ff22] text-[10px] text-[#8892a4]">
          <Fingerprint size={11} className="text-[#00d4ff]" /> Principal-native identity
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#c084fc0d] border border-[#c084fc22] text-[10px] text-[#8892a4]">
          <KeyRound size={11} className="text-[#c084fc]" /> OAuth 2.0 providers
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00e6760d] border border-[#00e67622] text-[10px] text-[#8892a4]">
          <Clock3 size={11} className="text-[#00e676]" /> Session management
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full border border-[#1e2d47] bg-[#131929] text-xs text-[#8892a4]">Coming soon</span>
        {/* Marketplace install dialog disabled for production launch (no funds yet) - see TODO.md
        <Button variant="primary" size="sm" className="gap-1.5" onClick={onBrowseMarket}>
          <Store size={14} /> Browse Market
        </Button>
        */}
        {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAskAI}>
          <Sparkles size={14} /> Ask AI to Add Auth
        </Button>
        */}
      </div>
    </div>
  );
}

/** "the Auth Page Home Displays Canisters that are Auth, when user click on
 * a Canister, it takes to the Auth Detail Page" (the user's own framing) -
 * mirrors `Database.tsx`'s exact list-then-drill-in pattern. A project can
 * have more than one `auth` canister, so this is always the first stop;
 * picking one navigates to `/project/:id/auth/:canisterId`
 * (`AuthDetail.tsx`) for real user management. No orchestrator call
 * anywhere on this page (see the `decouple-orchestrator-api` project
 * notes) - `auth` needs a real OAuth `Config` at deploy time (client id/
 * secret per provider), so there's no generic no-config "just deploy one"
 * flow the way the three database kinds have; getting one into a project
 * goes through Orchestrate. */
export default function AuthPage() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [showInstallDialog, setShowInstallDialog] = useState(false);

  const canisters = job ? listAuthCanisters(job) : null;

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <Shield size={18} className="text-[#00d4ff]" /> Auth
          </h2>
          <p className="text-sm text-[#4a5568] mt-1">This project's user-authentication canisters.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={refetch}>
            <RefreshCw size={13} /> Refresh
          </Button>
          {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
          {canisters && canisters.length > 0 && (
            <Button variant="primary" onClick={() => navigate(`/project/${job.id}/orchestrate`)}>
              <Sparkles size={14} /> Ask AI to Add Auth
            </Button>
          )}
*/}
        </div>
      </div>

      {canisters && canisters.length === 0 && (
        <AuthEmptyState onAskAI={() => navigate(`/project/${job.id}/orchestrate`)} onBrowseMarket={() => setShowInstallDialog(true)} />
      )}

      {canisters && canisters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {canisters.map((c) => (
            <Card
              key={c.id}
              className="cursor-pointer hover:border-[#00d4ff44] transition-colors group"
              onClick={() => navigate(`/project/${job.id}/auth/${c.id}`)}
            >
              <CardContent className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center flex-shrink-0">
                  <Shield size={16} className="text-[#00d4ff]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[#e2e8f0] truncate group-hover:text-[#00d4ff] transition-colors">{c.name}</div>
                  <div className="text-[10px] text-[#4a5568] font-mono truncate">{c.id}</div>
                </div>
                <ChevronRight size={16} className="text-[#4a5568] group-hover:text-[#00d4ff] transition-colors flex-shrink-0" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <InstallCanisterDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        jobId={job.id}
        network={job.network}
        onDeployed={refetch}
        initialQuery="auth"
      />
    </div>
  );
}
