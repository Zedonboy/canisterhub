import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, ExternalLink, ShoppingBag, Sparkles, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/StatusDot";
import { ToastProvider, toast } from "@/components/Toast";
import { CommandPalette } from "@/components/CommandPalette";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { TopNav } from "@/components/layout/TopNav";
import { Footer } from "@/components/layout/Footer";
import { relativeTime, type ServiceStatus } from "@/lib/mock-data";
import { listMyProjects, createProject, type Project } from "@/lib/backend";
import { useAuth } from "@/lib/auth";
import { localIcHost, runtimeNetwork } from "@/lib/canisterEnv";

/** A project's real state, mapped to the same status vocabulary StatusDot
 * uses - there's no real per-service health signal yet (that would need
 * each canister's own status polled individually), just this project's own
 * outcome. */
function jobStatus(project: Project): ServiceStatus {
  if (project.state === "failed") return "error";
  if (project.state === "running" || project.state === "awaiting_answer") return "degraded";
  return "healthy";
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [jobs, setJobs] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [creatingFromPrompt, setCreatingFromPrompt] = useState(false);
  const { status, principal } = useAuth();

  const refreshJobs = () => {
    listMyProjects()
      .then((real) => { setJobs(real); setLoadError(null); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  };

  // Re-fetches whenever the signed-in identity changes (sign in, sign out,
  // or a session restored after this page already mounted) - `backend`'s
  // `list_my_projects` is scoped to whichever principal is calling it (see
  // `lib/agent.ts`'s own identity-keyed agent cache), so a stale list from
  // the previous identity must never linger after that changes.
  useEffect(() => {
    refreshJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, principal]);

  const networkBadge = (net: string): "green" | "amber" | "gray" =>
    net === "ic" || net === "mainnet" ? "green" : net === "testnet" ? "amber" : "gray";

  // Real `create_project` (see `lib/backend.ts`), seeded with this exact
  // prompt as the new project's own `request` - then hands off to a real
  // Orchestrate conversation for it, same "describe it, let the AI build
  // it" pattern used throughout this app, just as the very first step
  // instead of something reached from inside an existing project.
  const submitPrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || creatingFromPrompt) return;
    setCreatingFromPrompt(true);
    try {
      const projectId = await createProject(trimmed, runtimeNetwork());
      navigate(`/project/${projectId}/orchestrate`, { state: { seed: trimmed } });
    } catch (e) {
      toast.error("Couldn't start this project", e instanceof Error ? e.message : String(e));
      setCreatingFromPrompt(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <TopNav active="projects" />

      <main className="flex-1 px-4 sm:px-6 py-6 max-w-7xl mx-auto w-full">
        <div className="py-12 flex flex-col items-center text-center animate-fade-in">
          <h1 className="text-3xl font-bold text-[#e2e8f0] mb-2">What will you build today?</h1>
          {/* AI prompt box + marketplace link disabled for production launch (no funds yet)
          <p className="text-sm text-[#4a5568] mb-8">
            Describe what you want, and Secretary will set up a new project for it
          </p>
          <div className="w-full max-w-2xl rounded-2xl border border-[#1e2d47] bg-[#0d1526] shadow-[0_0_50px_-18px_#00d4ff33] overflow-hidden text-left">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitPrompt();
                }
              }}
              disabled={creatingFromPrompt}
              placeholder='e.g. "Build a flight booking app with Stripe payments and an admin dashboard"'
              className="w-full min-h-[64px] bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none resize-none px-5 pt-4 disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[#1e2d47]">
              <span className="text-[11px] text-[#4a5568]">Enter to start · Shift+Enter for newline</span>
              <Button variant="primary" size="sm" className="gap-1.5 flex-shrink-0" onClick={submitPrompt} disabled={creatingFromPrompt || !prompt.trim()}>
                {creatingFromPrompt ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {creatingFromPrompt ? "Creating…" : "Start building"}
              </Button>
            </div>
          </div>
          <button
            onClick={() => navigate("/marketplace")}
            className="flex items-center gap-1.5 text-xs text-[#4a5568] hover:text-[#00d4ff] transition-colors mt-4"
          >
            <ShoppingBag size={12} />
            Browse the full Marketplace
          </button>
          */}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold text-[#e2e8f0]">Your Projects</h2>
            <p className="text-xs text-[#4a5568] mt-0.5">Manage your ICP canister projects</p>
          </div>
          <Button variant="primary" size="sm" className="gap-1.5 self-start sm:self-auto" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New Project
          </Button>
        </div>

        {loadError && (
          <p className="text-xs text-[#ff5252] mb-4">
            Couldn't reach the backend canister directly ({loadError}) - is the local replica running at{" "}
            {localIcHost()}, and is PUBLIC_CANISTER_ID:backend present in the runtime canister environment?
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {jobs.map((job) => {
            const name = job.project_name ?? job.request.slice(0, 40);
            const canisters = Object.entries(job.canisters);
            return (
              <Card key={job.id} className="hover:border-[#00d4ff33] transition-colors cursor-pointer group animate-fade-in">
                <CardContent className="p-0">
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-[#e2e8f0] group-hover:text-[#00d4ff] transition-colors">
                            {name}
                          </h3>
                          <Badge variant={networkBadge(job.network)}>{job.network}</Badge>
                        </div>
                        <p className="text-[10px] text-[#4a5568] font-mono mt-0.5">{job.id}</p>
                      </div>
                      <StatusDot status={jobStatus(job)} />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-[#4a5568]">
                      <span>{canisters.length} canister{canisters.length === 1 ? "" : "s"}</span>
                      <span>Updated {relativeTime(job.updated_at)}</span>
                    </div>
                  </div>

                  <div className="border-t border-[#1e2d47] flex">
                    <button
                      onClick={() => navigate(`/project/${job.id}/overview`)}
                      className="flex-1 py-2.5 text-xs text-[#8892a4] hover:text-[#00d4ff] hover:bg-[#00d4ff08] transition-colors flex items-center justify-center gap-1"
                    >
                      Open <ExternalLink size={10} />
                    </button>
                    <div className="w-px bg-[#1e2d47]" />
                    <button
                      onClick={() => navigate(`/project/${job.id}/settings`)}
                      className="flex-1 py-2.5 text-xs text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors"
                    >
                      Settings
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <button
            onClick={() => setShowCreate(true)}
            className="rounded border border-dashed border-[#1e2d47] hover:border-[#00d4ff44] hover:bg-[#00d4ff08] transition-all flex flex-col items-center justify-center gap-2 min-h-[200px] text-[#4a5568] hover:text-[#00d4ff]"
          >
            <Plus size={24} />
            <span className="text-sm">New Project</span>
          </button>
        </div>
      </main>

      <Footer />

      <ToastProvider />
      <CommandPalette />
      <CreateProjectDialog open={showCreate} onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/project/${id}/overview`)} />
    </div>
  );
}
