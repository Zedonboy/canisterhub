import { useState, useMemo } from "react";
import { Zap, Loader } from "lucide-react";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { toast } from "@/components/Toast";
import { createProject } from "@/lib/backend";
import { runtimeNetwork } from "@/lib/canisterEnv";

function toSlug(name: string) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called right after a real, synchronous `create_project` write
   * succeeds - no orchestrator call, no polling. */
  onCreated?: (projectId: string) => void;
}

/** "the dashboard only gets data from backend canister" (the user's own
 * framing) - this dialog writes a new project directly to `backend`, as the
 * real signed-in user. No AI/orchestrator involvement at all: that's a
 * separate concern (talking to Orchestrate about what to build inside a
 * project), not part of creating the project container itself. */
export function CreateProjectDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const slug = useMemo(() => toSlug(name), [name]);
  const canCreate = name.trim().length > 0 && !creating;

  const reset = () => { setName(""); setCreating(false); };
  const handleClose = () => { reset(); onClose(); };

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    const savedName = name;
    try {
      const projectId = await createProject(savedName, runtimeNetwork());
      reset();
      onClose();
      toast.success(`"${savedName}" created`, "Opening your new project…");
      onCreated?.(projectId);
    } catch (e) {
      setCreating(false);
      toast.error("Couldn't create this project", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} className="max-w-md">
      <DialogHeader title="New Project" onClose={handleClose} />

      <DialogContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="proj-name">Project Name</Label>
          <Input
            id="proj-name"
            placeholder="My ICP App"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          {slug.length > 0 && (
            <p className="text-[11px] text-[#4a5568]">
              slug: <span className="font-mono text-[#00d4ff]">{slug}</span>
            </p>
          )}
        </div>
      </DialogContent>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canCreate}
          onClick={handleCreate}
          className="gap-1.5 min-w-[100px] justify-center"
        >
          {creating ? (
            <><Loader size={13} className="animate-spin" /> Creating...</>
          ) : (
            <><Zap size={13} fill="currentColor" /> Create Project</>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
