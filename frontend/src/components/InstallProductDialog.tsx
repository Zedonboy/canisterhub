import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Loader2, Plus, Settings2, Sparkles } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { Dialog, DialogHeader, DialogContent } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Label } from "@/components/ui/Input";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { listMyProjects, type Project } from "@/lib/backend";
import { type Product } from "@/lib/products";
import { deployPackageInfo } from "@/lib/deploy";
import { useAuth } from "@/lib/auth";
import { toast } from "@/components/Toast";

const NETWORK_BADGE: Record<string, "green" | "amber" | "gray"> = {
  ic: "green",
  local: "gray",
};
const CYCLES_PER_TCYCLE = 1_000_000_000_000n;

function parseTcycles(value: string): bigint | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,12}))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(12, "0"));
  const cycles = whole * CYCLES_PER_TCYCLE + fraction;
  return cycles > 0n ? cycles : null;
}

interface InstallProductDialogProps {
  open: boolean;
  onClose: () => void;
  product: Product;
}

/** Opened by the product detail page's Install button. A product is a real
 * MarketplaceItem, so this uses the same payment, vetKD decryption, and
 * deployment flow as every other marketplace entry. */
export function InstallProductDialog({ open, onClose, product }: InstallProductDialogProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [installingProjectId, setInstallingProjectId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [cyclesBudgetT, setCyclesBudgetT] = useState("2");
  const navigate = useNavigate();
  const { principal } = useAuth();

  useEffect(() => {
    if (!open) return;
    setProjects(null);
    setLoadError(null);
    setInstallingProjectId(null);
    setShowSettings(false);
    setCyclesBudgetT("2");
    listMyProjects()
      .then(setProjects)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const goInstall = async (project: Project) => {
    if (!principal) {
      toast.error("Not signed in", "Sign in again and retry.");
      return;
    }
    const cyclesBudget = parseTcycles(cyclesBudgetT);
    if (cyclesBudget === null) {
      toast.error("Check the cycles budget", "Enter a positive amount in T cycles, with at most 12 decimal places.");
      return;
    }

    setInstallingProjectId(project.id);
    try {
      const deployed = await deployPackageInfo(
        product.packageInfo,
        project.network,
        project.id,
        Principal.fromText(principal),
        undefined,
        cyclesBudget,
      );
      toast.success(`${product.name} installed`, `Canister ${deployed.id} is live.`);
      onClose();
      navigate(`/project/${project.id}/orchestrate`, {
        state: {
          seed: `I installed ${product.name} as canister ${deployed.id} (named "${deployed.name}"). Help me wire it into this project.`,
        },
      });
    } catch (error) {
      toast.error(`Couldn't install ${product.name}`, error instanceof Error ? error.message : String(error));
      setInstallingProjectId(null);
    }
  };

  return (
    <>
      <Dialog open={open && !showCreateProject} onClose={() => installingProjectId === null && onClose()}>
        <DialogHeader title={`Install ${product.name}`} onClose={installingProjectId === null ? onClose : undefined} />
        <DialogContent className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#4a5568]">Choose which project to set {product.name} up in.</p>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setShowCreateProject(true)}>
              <Plus size={13} /> New project
            </Button>
          </div>

          <div className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a]">
            <button
              type="button"
              aria-expanded={showSettings}
              aria-controls="package-install-settings"
              disabled={installingProjectId !== null}
              onClick={() => setShowSettings((current) => !current)}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-[#8892a4] hover:text-[#e2e8f0] transition-colors disabled:opacity-50"
            >
              <Settings2 size={13} />
              <span className="flex-1">Install settings</span>
              <span className="font-mono text-[#00d4ff]">{cyclesBudgetT || "—"}T</span>
              {showSettings ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {showSettings && (
              <div id="package-install-settings" className="border-t border-[#1e2d47] p-3">
                <Label htmlFor="package-cycles-budget">Cycles budget</Label>
                <div className="relative">
                  <Input
                    id="package-cycles-budget"
                    type="text"
                    inputMode="decimal"
                    value={cyclesBudgetT}
                    onChange={(event) => setCyclesBudgetT(event.target.value)}
                    disabled={installingProjectId !== null}
                    className="pr-16"
                    aria-describedby="package-cycles-budget-help"
                  />
                  <span className="absolute inset-y-0 right-3 flex items-center text-xs text-[#4a5568] pointer-events-none">T cycles</span>
                </div>
                <p id="package-cycles-budget-help" className="mt-1.5 text-[11px] text-[#4a5568]">
                  Cycles used to create and fund the new canister. The default is 2T.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {loadError && <p className="text-xs text-[#ff5252] px-1 py-2">Couldn't load your projects: {loadError}</p>}
            {!loadError && projects === null && <p className="text-xs text-[#4a5568] px-1 py-2">Loading your projects…</p>}
            {projects !== null && projects.length === 0 && (
              <p className="text-xs text-[#4a5568] px-1 py-2">
                You don't have any projects yet - create one to install {product.name} into.
              </p>
            )}
            {projects !== null && projects.length > 0 && projects.map((project) => {
              const name = project.project_name ?? project.request.slice(0, 40);
              return (
                <div key={project.id} className="flex items-center gap-3 p-3 rounded-lg border border-[#1e2d47] hover:border-[#2a3f5f] transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[#e2e8f0] truncate">{name}</span>
                      <Badge variant={NETWORK_BADGE[project.network] ?? "gray"}>{project.network}</Badge>
                    </div>
                    <div className="text-[11px] text-[#4a5568] font-mono truncate">{project.id}</div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className="gap-1.5 flex-shrink-0"
                    disabled={installingProjectId !== null}
                    onClick={() => void goInstall(project)}
                  >
                    {installingProjectId === project.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {installingProjectId === project.id
                      ? "Installing…"
                      : product.purchased
                        ? "Download & install"
                      : "Install"}
                  </Button>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <CreateProjectDialog
        open={showCreateProject}
        onClose={() => setShowCreateProject(false)}
        onCreated={(projectId) => {
          setShowCreateProject(false);
          listMyProjects()
            .then((nextProjects) => {
              setProjects(nextProjects);
              const project = nextProjects.find((candidate) => candidate.id === projectId);
              if (!project) throw new Error("The new project could not be loaded.");
              return goInstall(project);
            })
            .catch((error) => toast.error(`Couldn't install ${product.name}`, error instanceof Error ? error.message : String(error)));
        }}
      />
    </>
  );
}
