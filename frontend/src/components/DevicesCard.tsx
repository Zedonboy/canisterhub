import { useCallback, useEffect, useState } from "react";
import { Laptop, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { CanisterID } from "@/components/CanisterID";
import { toast } from "@/components/Toast";
import { relativeTime } from "@/lib/mock-data";
import {
  listDevices,
  registerDevice,
  deregisterDevice,
  syncDeviceControllers,
  type ControllerSyncResult,
  type DeviceInfo,
} from "@/lib/devices";

function failures(results: ControllerSyncResult[]) {
  return results.filter((r) => !r.ok);
}

/** Devices of one project: another principal (e.g. your other Internet
 * Identity) that may work on this project only. Adding one registers it on
 * `backend` and adds it as a controller of every canister the project tracks. */
export function DevicesCard({ projectId, owner, principal }: { projectId: string; owner: string; principal: string }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const isDevice = owner !== principal;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newPrincipal, setNewPrincipal] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<ControllerSyncResult[]>([]);

  const load = useCallback(async () => {
    try {
      setDevices(await listDevices(projectId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = (results: ControllerSyncResult[], done: string) => {
    const failed = failures(results);
    setProblems(failed);
    if (failed.length === 0) toast("success", done, `${results.length} canister(s) checked`);
    else toast("warning", "Some canisters could not be updated", `${failed.length} of ${results.length} failed - see below`);
  };

  const handleAdd = async () => {
    setBusy("add");
    try {
      await registerDevice(projectId, newPrincipal, label);
      setNewPrincipal("");
      setLabel("");
      await load();
      report(await syncDeviceControllers(projectId, newPrincipal.trim(), "add", principal), "Device added");
    } catch (e) {
      toast("error", "Couldn't add device", e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const handleResync = async (device: string) => {
    setBusy(device);
    try {
      report(await syncDeviceControllers(projectId, device, "add", principal), "Controllers synced");
    } catch (e) {
      toast("error", "Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Controllers first: a device is only deregistered once it no longer
   * controls anything, so a failure leaves it listed and retryable. */
  const handleRemove = async (device: string, force: boolean) => {
    setBusy(device);
    try {
      if (!force) {
        const results = await syncDeviceControllers(projectId, device, "remove", principal);
        const failed = failures(results);
        if (failed.length > 0) {
          setProblems(failed);
          toast("error", "Device not removed", `It is still a controller of ${failed.length} canister(s). Retry, or use "Remove access only".`);
          return;
        }
      }
      await deregisterDevice(projectId, device);
      setProblems([]);
      toast("success", "Device removed");
      await load();
    } catch (e) {
      toast("error", "Couldn't remove device", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Devices</CardTitle>
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => void load()}>
          <RefreshCw size={13} /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[#8892a4]">
          A device is another principal (for example your other Internet Identity) that can work on this project only:
          it becomes a controller of every canister the project tracks.
        </p>
        {loadError && <div className="text-xs text-[#ff5252]">Couldn't load devices: {loadError}</div>}
        {isDevice && (
          <div className="text-xs text-[#ffb74d]">
            You are signed in as a device of this project. Only the owner can add or remove devices.
          </div>
        )}
        <div className="divide-y divide-[#1e2d47]">
          {devices.length === 0 && <div className="text-sm text-[#4a5568] py-2">No devices added.</div>}
          {devices.map((d) => (
            <div key={d.principal} className="flex items-center justify-between gap-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Laptop size={14} className="text-[#00d4ff] flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm text-[#e2e8f0]">{d.label}</div>
                  <CanisterID id={d.principal} className="text-xs" />
                  <div className="text-[11px] text-[#4a5568]">Added {relativeTime(d.addedAt)}</div>
                </div>
              </div>
              {!isDevice && (
                <div className="flex gap-2 flex-shrink-0">
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void handleResync(d.principal)}>
                    Sync controllers
                  </Button>
                  <Button variant="danger" size="sm" className="gap-1" disabled={busy !== null} onClick={() => void handleRemove(d.principal, false)}>
                    <Trash2 size={12} /> Remove
                  </Button>
                  {problems.length > 0 && (
                    <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void handleRemove(d.principal, true)}>
                      Remove access only
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {!isDevice && (
          <div className="space-y-2">
            <Label>Add a device</Label>
            <Input placeholder="Device principal" value={newPrincipal} onChange={(e) => setNewPrincipal(e.target.value)} />
            <Input placeholder="Label (e.g. Work laptop)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button
              variant="primary"
              size="sm"
              className="gap-1.5"
              disabled={busy !== null || !newPrincipal.trim() || !label.trim()}
              onClick={() => void handleAdd()}
            >
              <Plus size={13} /> {busy === "add" ? "Adding…" : "Add device"}
            </Button>
          </div>
        )}

        {problems.length > 0 && (
          <div className="rounded border border-[#ff525244] p-3 space-y-1">
            <div className="text-xs font-medium text-[#ff5252]">Controller changes that did not apply</div>
            {problems.map((p) => (
              <div key={`${p.network}:${p.canisterId}`} className="text-xs text-[#8892a4]">
                {p.canisterName} ({p.canisterId}): {p.error}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
