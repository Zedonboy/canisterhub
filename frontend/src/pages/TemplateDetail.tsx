import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink, FileCode2, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CommandPalette } from "@/components/CommandPalette";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/Dialog";
import { Footer } from "@/components/layout/Footer";
import { Input, Label } from "@/components/ui/Input";
import { TopNav } from "@/components/layout/TopNav";
import { ToastProvider } from "@/components/Toast";
import { Principal } from "@icp-sdk/core/principal";
import { MarketplaceItemType, type MarketplaceItem } from "@/bindings/backend";
import { recordDownload } from "@/lib/marketplace";
import { getTemplate } from "@/lib/templates";
import { createProject, setProjectName } from "@/lib/backend";
import { runtimeNetwork } from "@/lib/canisterEnv";
import { useAuth } from "@/lib/auth";
import { installTemplatePackages, prepareTemplateInstall, templateCyclesEstimate, type PreparedTemplateInstall } from "@/lib/templateInstaller";

type InstallPhase = "idle" | "preparing" | "ready" | "installing" | "error";

const NETWORK_LABEL: Record<string, string> = { local: "Local replica", ic: "ICP mainnet" };

export default function TemplateDetail() {
  const { template_id: templateId = "" } = useParams();
  const navigate = useNavigate();
  const { principal } = useAuth();
  const [item, setItem] = useState<MarketplaceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState("");
  const [plan, setPlan] = useState<PreparedTemplateInstall | null>(null);
  const [projectName, setProjectNameInput] = useState("");
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);

  const beginInstall = () => {
    if (!item) return;
    setInstallOpen(true);
    setInstallPhase("preparing");
    setInstallError(null);
    setInstallProgress("Downloading and verifying the template manifest…");
    setProjectNameInput(`${item.title} Project`);
    setCreatedProjectId(null);
    setPlan(null);
    prepareTemplateInstall(item)
      .then((prepared) => {
        setPlan(prepared);
        setInstallPhase("ready");
        setInstallProgress("");
      })
      .catch((reason) => {
        setInstallError(reason instanceof Error ? reason.message : String(reason));
        setInstallPhase("error");
      });
  };

  const install = async () => {
    if (!plan || !item) return;
    if (!principal) {
      setInstallError("Sign in again before installing a template.");
      setInstallPhase("error");
      return;
    }
    const cleanProjectName = projectName.trim();
    if (!cleanProjectName) {
      setInstallError("Enter a name for the new project.");
      setInstallPhase("error");
      return;
    }

    setInstallPhase("installing");
    setInstallError(null);
    setInstallProgress("Creating the project…");
    const network = runtimeNetwork();
    try {
      const projectId = await createProject(cleanProjectName, network);
      setCreatedProjectId(projectId);
      await setProjectName(projectId, cleanProjectName);
      const deployed = await installTemplatePackages(
        plan,
        network,
        projectId,
        Principal.fromText(principal),
        setInstallProgress,
      );
      await recordDownload(item.id);
      navigate(`/project/${projectId}/overview`, {
        state: {
          notice: `Installed ${item.title}: ${deployed.length} package canisters were deployed and configured.`,
        },
      });
    } catch (reason) {
      setInstallError(reason instanceof Error ? reason.message : String(reason));
      setInstallPhase("error");
    }
  };

  const closeInstall = () => {
    if (installPhase !== "installing") {
      setInstallOpen(false);
      setInstallPhase("idle");
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    let id: bigint;
    try {
      id = BigInt(templateId);
    } catch {
      setError("This template link is invalid.");
      setLoading(false);
      return () => { active = false; };
    }
    getTemplate(id)
      .then((result) => {
        if (!active) return;
        if (!result || result.item_type !== MarketplaceItemType.Template) {
          setError("This template could not be found.");
          return;
        }
        setItem(result);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [templateId]);

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <TopNav active="marketplace" />
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 py-8 space-y-8">
        <button
          onClick={() => navigate("/marketplace")}
          className="flex items-center gap-2 text-sm text-[#4a5568] hover:text-[#e2e8f0] transition-colors"
        >
          <ArrowLeft size={15} /> Back to Marketplace
        </button>

        {loading && <p className="py-16 text-center text-sm text-[#4a5568]">Loading template…</p>}
        {!loading && error && (
          <div className="py-16 text-center space-y-4">
            <p className="text-sm text-[#ff6b6b]">Couldn't load this template: {error}</p>
            <Button variant="secondary" onClick={() => navigate("/marketplace")}>Back to Marketplace</Button>
          </div>
        )}

        {!loading && item && (
          <>
            <section className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6 animate-fade-in">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 rounded-2xl bg-[#c084fc11] border border-[#c084fc33] text-[#c084fc] flex items-center justify-center shrink-0">
                  <FileCode2 size={27} />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <h1 className="text-2xl font-bold text-[#e2e8f0]">{item.title}</h1>
                    <Badge variant="gray">Template</Badge>
                  </div>
                  <p className="text-sm text-[#8892a4] leading-relaxed">{item.description}</p>
                  <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-[#4a5568]">
                    <span className="flex items-center gap-1"><Download size={12} /> {item.downloads.toString()} downloads</span>
                    <span>Slug: <code className="text-[#8892a4]">{item.package_slug}</code></span>
                  </div>
                </div>
              </div>
                <Button variant="primary" className="gap-2 shrink-0" onClick={beginInstall}>
                  <Sparkles size={14} /> Install template
                </Button>
            </section>

            <section className="p-5 rounded-xl border border-[#1e2d47] bg-[#0d1526]">
              <h2 className="text-xs font-semibold text-[#4a5568] uppercase tracking-widest mb-2">About this template</h2>
              <p className="text-sm text-[#8892a4] leading-relaxed">
                This template manifest describes the canister packages and configuration used to set up this project.
                Review the manifest before using it.
              </p>
            </section>

            <section className="p-5 rounded-xl border border-[#1e2d47] bg-[#0d1526]">
              <h2 className="text-xs font-semibold text-[#4a5568] uppercase tracking-widest mb-3">Publisher</h2>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <a href={item.git_repo_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#00d4ff] hover:underline">
                  Source repository <ExternalLink size={13} />
                </a>
                {item.web_url && (
                  <a href={item.web_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#00d4ff] hover:underline">
                    Project website <ExternalLink size={13} />
                  </a>
                )}
                <span className="text-xs text-[#4a5568]">Publisher: {item.publisher.toText()}</span>
              </div>
            </section>
          </>
        )}
      </main>
      <Footer />
      <Dialog open={installOpen} onClose={closeInstall} className="max-w-xl">
        <DialogHeader title={`Install ${item?.title ?? "template"}`} onClose={installPhase === "installing" ? undefined : closeInstall} />
        <DialogContent className="space-y-5">
          {installPhase === "preparing" && (
            <div className="flex items-center gap-3 py-5 text-sm text-[#8892a4]">
              <Loader2 size={17} className="animate-spin text-[#00d4ff]" /> {installProgress}
            </div>
          )}
          {installPhase === "ready" && plan && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="template-project-name">New project name</Label>
                <Input id="template-project-name" value={projectName} onChange={(event) => setProjectNameInput(event.target.value)} autoFocus />
                <p className="text-[11px] text-[#4a5568]">Templates create a new project before any canisters are installed.</p>
              </div>
              <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-4 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs text-[#8892a4]">Target network</span>
                  <Badge variant={runtimeNetwork() === "ic" ? "green" : "gray"}>{NETWORK_LABEL[runtimeNetwork()] ?? runtimeNetwork()}</Badge>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs text-[#8892a4]">Canisters</span>
                  <span className="text-sm text-[#e2e8f0]">{plan.packages.length}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs text-[#8892a4]">Estimated cycles</span>
                  <span className="text-sm font-mono text-[#00d4ff]">{templateCyclesEstimate(plan.packages.length).toLocaleString()}</span>
                </div>
                <p className="text-[11px] text-[#4a5568]">2,000,000,000,000 cycles per canister × {plan.packages.length} packages. The cycles ledger funds each new canister.</p>
                <ul className="space-y-1 border-t border-[#1e2d47] pt-3">
                  {plan.packages.map((pkg) => (
                    <li key={pkg.alias} className="flex justify-between gap-3 text-xs">
                      <span className="text-[#e2e8f0]">{pkg.alias}</span>
                      <code className="text-[#4a5568]">{pkg.packageName} · 2T cycles</code>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-[11px] text-[#4a5568]">After deployment, the installer applies the template’s dynamic settings and canister links.</p>
            </>
          )}
          {installPhase === "installing" && (
            <div className="flex items-center gap-3 py-5 text-sm text-[#8892a4]">
              <Loader2 size={17} className="animate-spin text-[#00d4ff]" /> {installProgress}
            </div>
          )}
          {installPhase === "error" && (
            <div className="space-y-3">
              <p className="text-sm text-[#ff6b6b]">{installError}</p>
              {createdProjectId && (
                <p className="text-xs text-[#8892a4]">The project was created at {createdProjectId}. Any canisters already installed remain there.</p>
              )}
            </div>
          )}
        </DialogContent>
        {installPhase === "ready" && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={closeInstall}>Cancel</Button>
            <Button variant="primary" size="sm" className="gap-1.5" disabled={!projectName.trim()} onClick={() => void install()}>
              <Sparkles size={13} /> Create project & install
            </Button>
          </DialogFooter>
        )}
        {installPhase === "error" && (
          <DialogFooter>
            {createdProjectId && <Button variant="secondary" size="sm" onClick={() => navigate(`/project/${createdProjectId}/overview`)}>Open project</Button>}
            <Button variant="ghost" size="sm" onClick={closeInstall}>Close</Button>
          </DialogFooter>
        )}
      </Dialog>
      <ToastProvider />
      <CommandPalette />
    </div>
  );
}
