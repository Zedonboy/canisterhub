import { useEffect, useState } from "react";
import { useNavigate, useOutletContext, Link } from "react-router-dom";
import { Settings, Server, AlertTriangle, Square, Trash2, Download, ExternalLink, Bell, BellOff, BellRing } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Table, TableHead, TableBody, Th, Tr, Td } from "@/components/ui/Table";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { CanisterID } from "@/components/CanisterID";
import { toast } from "@/components/Toast";
import { relativeTime } from "@/lib/mock-data";
import type { ProjectContext } from "@/components/layout/AppShell";
import { setProjectName, deleteProject, removeProjectCanister, type Project, type CanisterKind } from "@/lib/backend";
import { stopCanister, deleteCanister } from "@/lib/canisterOps";
import { isPushSupported, getPushStatus, enablePushNotifications, disablePushNotifications } from "@/lib/pushNotifications";
import { clsx } from "clsx";

const KIND_LABELS: Record<CanisterKind, string> = {
  connector: "Connector",
  agent: "Agent",
  admin_agent: "Admin Agent",
  auth: "Auth",
  database: "Database",
  analytics: "Analytics",
  static: "Static",
  other: "Other",
};

/** Real browser Web Push subscribe/unsubscribe (`lib/pushNotifications.ts`) -
 * account-wide, not actually scoped to this one project (a subscription is
 * tied to the signed-in principal, same as the Wallet), but shown here on
 * the General tab since this is where account-level preferences live.
 * `"denied"` is a dead end this UI can't undo - only the browser's own site
 * settings can, so that state just explains itself instead of showing a
 * now-useless toggle. */
function PushNotificationsCard() {
  const [status, setStatus] = useState<"loading" | "enabled" | "disabled" | "denied">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) {
      setStatus("disabled");
      return;
    }
    getPushStatus().then(setStatus).catch(() => setStatus("disabled"));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      await enablePushNotifications();
      setStatus("enabled");
      toast.success("Notifications enabled", "This browser will now receive push notifications.");
    } catch (e) {
      toast.error("Couldn't enable notifications", e instanceof Error ? e.message : String(e));
      setStatus(await getPushStatus().catch(() => "disabled"));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await disablePushNotifications();
      setStatus("disabled");
      toast.success("Notifications disabled");
    } catch (e) {
      toast.error("Couldn't disable notifications", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Notifications</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center flex-shrink-0 mt-0.5">
              {status === "enabled" ? <BellRing size={14} className="text-[#00d4ff]" /> : <Bell size={14} className="text-[#8892a4]" />}
            </div>
            <div>
              <div className="text-sm text-[#e2e8f0]">Push notifications</div>
              <p className="text-xs text-[#4a5568] mt-0.5 max-w-sm">
                {status === "denied"
                  ? "Blocked in your browser's site settings for this page - allow notifications there to turn this on."
                  : "Get notified in this browser when something needs your attention, even when the dashboard isn't open."}
              </p>
            </div>
          </div>
          {status !== "denied" && (
            <Button
              variant={status === "enabled" ? "secondary" : "primary"}
              size="sm"
              className="gap-1.5 flex-shrink-0"
              disabled={busy || status === "loading"}
              onClick={status === "enabled" ? disable : enable}
            >
              {status === "enabled" ? <BellOff size={13} /> : <Bell size={13} />}
              {busy ? "Working…" : status === "loading" ? "Checking…" : status === "enabled" ? "Disable" : "Enable"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Real project details, directly from `backend` - no fake team/roles
 * section (there's no real multi-user concept anywhere in this codebase
 * yet, so this doesn't pretend there is one). Only `project_name` has a
 * real update method (`set_project_name`) - `request`/`network`/`owner`
 * are set once at creation with nothing to edit them, so they're shown
 * read-only rather than as disabled-looking editable fields. */
function GeneralTab({ job, refetch }: { job: Project; refetch: () => void }) {
  const [name, setName] = useState(job.project_name ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === job.project_name) return;
    setSaving(true);
    try {
      await setProjectName(job.id, trimmed);
      toast.success("Name saved");
      refetch();
    } catch (e) {
      toast.error("Couldn't save the name", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 space-y-4 max-w-2xl">
      <Card>
        <CardHeader><CardTitle>Project Details</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="project-name">Project Name</Label>
            <div className="flex gap-2">
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
              <Button variant="primary" size="sm" disabled={saving || !name.trim() || name.trim() === job.project_name} onClick={save}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <p className="text-sm text-[#8892a4] mt-1">{job.request}</p>
          </div>
          <div>
            <Label>Project ID</Label>
            <p className="text-xs font-mono text-[#4a5568] mt-1">{job.id}</p>
          </div>
          <div>
            <Label>Owner Principal</Label>
            <CanisterID id={job.owner} className="mt-1" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-[#4a5568]">
            <div>Created {new Date(job.created_at).toLocaleString()}</div>
            <div>Updated {relativeTime(job.updated_at)}</div>
          </div>
        </CardContent>
      </Card>

      <PushNotificationsCard />
    </div>
  );
}

/** A read-only real listing of this project's tracked canisters - actual
 * lifecycle operations (start/stop/delete, one at a time) live on the
 * Overview page's own canister cards, not duplicated here. */
function CanistersTab({ job }: { job: Project }) {
  const canisters = Object.entries(job.canisters);

  if (canisters.length === 0) {
    return (
      <div className="p-4 max-w-2xl">
        <p className="text-sm text-[#4a5568]">
          No canisters in this project yet - install one from the{" "}
          <Link to={`/project/${job.id}/overview`} className="text-[#00d4ff] hover:underline">Overview page</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 max-w-3xl">
      <Table>
        <TableHead>
          <tr><Th>Name</Th><Th>Canister ID</Th><Th>Type</Th><Th></Th></tr>
        </TableHead>
        <TableBody>
          {canisters.map(([name, info]) => (
            <Tr key={name}>
              <Td className="font-medium text-[#e2e8f0]">{name}</Td>
              <Td><CanisterID id={info.id} /></Td>
              <Td className="text-[#8892a4]">{KIND_LABELS[info.kind]}</Td>
              <Td>
                <Link to={`/project/${job.id}/overview`} className="inline-flex items-center gap-1 text-xs text-[#00d4ff] hover:underline">
                  Manage <ExternalLink size={11} />
                </Link>
              </Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DangerZoneTab({ job, refetch }: { job: Project; refetch: () => void }) {
  const navigate = useNavigate();
  const canisters = Object.entries(job.canisters);
  const [stopping, setStopping] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [showDeleteProject, setShowDeleteProject] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.project_name ?? job.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported", "The real project record was downloaded as JSON.");
  };

  const stopAll = async () => {
    setStopping(true);
    const failures: string[] = [];
    for (const [name, info] of canisters) {
      try {
        await stopCanister(info.id, job.network);
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setStopping(false);
    if (failures.length === 0) toast.success("All canisters stopped");
    else toast.error(`${failures.length} of ${canisters.length} failed to stop`, failures.join("; "));
  };

  const deleteAll = async () => {
    setDeletingAll(true);
    const failures: string[] = [];
    for (const [name, info] of canisters) {
      try {
        await deleteCanister(info.id, job.network);
        await removeProjectCanister(job.id, name);
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setDeletingAll(false);
    setShowDeleteAll(false);
    refetch();
    if (failures.length === 0) toast.success("All canisters deleted");
    else toast.error(`${failures.length} of ${canisters.length} failed to delete`, failures.join("; "));
  };

  const deleteProjectNow = async () => {
    setDeletingProject(true);
    try {
      await deleteProject(job.id);
      toast.success("Project deleted");
      navigate("/dashboard");
    } catch (e) {
      toast.error("Couldn't delete this project", e instanceof Error ? e.message : String(e));
      setDeletingProject(false);
    }
  };

  const projectLabel = job.project_name ?? job.id;

  return (
    <div className="p-4 space-y-3 max-w-2xl">
      <div className="bg-[#ff525211] border border-[#ff525244] rounded p-4 space-y-1">
        <h3 className="text-sm font-semibold text-[#ff5252] flex items-center gap-2">
          <AlertTriangle size={14} /> Danger Zone
        </h3>
        <p className="text-xs text-[#4a5568]">Every action below is real and, except where noted, irreversible.</p>
      </div>

      <Card>
        <CardContent className="space-y-2 divide-y divide-[#1e2d47]">
          <div className="flex items-center justify-between py-3 first:pt-0">
            <div>
              <div className="text-sm text-[#e2e8f0]">Stop all canisters</div>
              <div className="text-xs text-[#4a5568]">Real management-canister calls, one per canister in this project.</div>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={canisters.length === 0 || stopping} onClick={stopAll}>
              <Square size={12} /> {stopping ? "Stopping…" : "Stop All"}
            </Button>
          </div>

          <div className="flex items-center justify-between py-3">
            <div>
              <div className="text-sm text-[#e2e8f0]">Export project data</div>
              <div className="text-xs text-[#4a5568]">Downloads this project's real record (as stored on-chain) as JSON.</div>
            </div>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={exportData}>
              <Download size={12} /> Export
            </Button>
          </div>

          <div className="flex items-center justify-between py-3">
            <div>
              <div className="text-sm text-[#e2e8f0]">Delete all canisters</div>
              <div className="text-xs text-[#ff5252]">Permanently deletes every canister in this project. Cannot be undone.</div>
            </div>
            <Button variant="danger" size="sm" className="gap-1.5" disabled={canisters.length === 0} onClick={() => setShowDeleteAll(true)}>
              <Trash2 size={12} /> Delete All
            </Button>
          </div>

          <div className="flex items-center justify-between py-3 last:pb-0">
            <div>
              <div className="text-sm text-[#e2e8f0]">Delete project</div>
              <div className="text-xs text-[#ff5252]">
                {canisters.length > 0
                  ? "Delete or remove every canister first - this only removes the project's own record, never a live canister."
                  : "Permanently deletes this project's record. Cannot be undone."}
              </div>
            </div>
            <Button variant="danger" size="sm" className="gap-1.5" disabled={canisters.length > 0} onClick={() => setShowDeleteProject(true)}>
              <Trash2 size={12} /> Delete Project
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDeleteAll} onClose={() => !deletingAll && setShowDeleteAll(false)}>
        <DialogHeader title="Delete all canisters" onClose={deletingAll ? undefined : () => setShowDeleteAll(false)} />
        <DialogContent>
          <div className="bg-[#ff525211] border border-[#ff525444] rounded p-3 text-xs text-[#ff5252]">
            This permanently deletes all {canisters.length} canister{canisters.length !== 1 ? "s" : ""} in this project. The IC itself won't undo this.
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setShowDeleteAll(false)} disabled={deletingAll}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={deleteAll} disabled={deletingAll}>{deletingAll ? "Deleting…" : "Delete All Forever"}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={showDeleteProject} onClose={() => !deletingProject && setShowDeleteProject(false)}>
        <DialogHeader title="Delete Project" onClose={deletingProject ? undefined : () => setShowDeleteProject(false)} />
        <DialogContent className="space-y-3">
          <div className="bg-[#ff525211] border border-[#ff525444] rounded p-3 text-xs text-[#ff5252]">
            This action is irreversible. The project's record will be permanently deleted.
          </div>
          <div>
            <Label>Type <span className="font-mono text-[#ff5252]">{projectLabel}</span> to confirm:</Label>
            <Input
              placeholder={projectLabel}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="border-[#ff525444] focus:border-[#ff5252]"
              disabled={deletingProject}
            />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setShowDeleteProject(false)} disabled={deletingProject}>Cancel</Button>
          <Button variant="danger" size="sm" disabled={confirmName !== projectLabel || deletingProject} onClick={deleteProjectNow}>
            {deletingProject ? "Deleting…" : "Delete Forever"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

export default function SettingsPage() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const [activeTab, setActiveTab] = useState("general");

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const tabs = [
    { id: "general", label: "General", icon: <Settings size={13} /> },
    { id: "canisters", label: "Canisters", icon: <Server size={13} /> },
    { id: "danger", label: "Danger Zone", icon: <AlertTriangle size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="px-6 pt-4 pb-0 border-b border-[#1e2d47]">
        <h1 className="text-lg font-semibold text-[#e2e8f0] mb-3">Settings</h1>
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px",
                activeTab === tab.id
                  ? tab.id === "danger" ? "text-[#ff5252] border-[#ff5252]" : "text-[#00d4ff] border-[#00d4ff]"
                  : tab.id === "danger" ? "text-[#ff525288] border-transparent hover:text-[#ff5252]" : "text-[#8892a4] border-transparent hover:text-[#e2e8f0]"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {activeTab === "general" && <GeneralTab job={job} refetch={refetch} />}
        {activeTab === "canisters" && <CanistersTab job={job} />}
        {activeTab === "danger" && <DangerZoneTab job={job} refetch={refetch} />}
      </div>
    </div>
  );
}
