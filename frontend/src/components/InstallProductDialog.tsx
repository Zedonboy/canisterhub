import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { Dialog, DialogHeader, DialogContent } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { listMyProjects, type Project } from "@/lib/backend";
import { type Product } from "@/lib/products";
import { deployMarketplaceItem } from "@/lib/deploy";
import { useAuth } from "@/lib/auth";
import { toast } from "@/components/Toast";

const NETWORK_BADGE: Record<string, "green" | "amber" | "gray"> = {
  ic: "green",
  local: "gray",
};

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
  const navigate = useNavigate();
  const { principal } = useAuth();

  useEffect(() => {
    if (!open) return;
    setProjects(null);
    setLoadError(null);
    setInstallingProjectId(null);
    listMyProjects()
      .then(setProjects)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const goInstall = async (project: Project) => {
    if (!principal) {
      toast.error("Not signed in", "Sign in again and retry.");
      return;
    }

    setInstallingProjectId(project.id);
    try {
      const deployed = await deployMarketplaceItem(
        product.item,
        project.network,
        project.id,
        Principal.fromText(principal),
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
                        : product.item.price !== undefined
                          ? "Buy & install"
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
