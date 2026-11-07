import { useEffect, useState } from "react";
import { Plus, Trash2, Shield } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { listPermissions, setPermission, removePermission, type Permission, type PermissionLevel } from "@/lib/permissions";

const LEVELS: { value: PermissionLevel; label: string; variant: "green" | "amber" | "red" }[] = [
  { value: "read_write", label: "Read/Write", variant: "green" },
  { value: "read_only", label: "Read-only", variant: "amber" },
  { value: "blocked", label: "Blocked", variant: "red" },
];

function levelMeta(level: PermissionLevel) {
  return LEVELS.find((l) => l.value === level) ?? LEVELS[0];
}

/** Controller-only ACL management for this canister's own `database`
 * permission module (see `lib/permissions.ts`'s own doc comment) - every
 * caller resolves to exactly one of `Blocked`/`ReadOnly`/`ReadWrite` (see
 * `packages/ic-sql/src/auth.rs`'s `decide`), and an explicit entry here
 * always wins over the default (anonymous: read-only; anyone else:
 * read-write, unless an `auth_canister` is configured). Reading this list
 * is public on the real canister; `set`/`remove` reject anyone who isn't
 * a controller with the canister's own real error message, surfaced here
 * rather than pre-checked client-side. */
export default function PermissionsPanel() {
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newPrincipal, setNewPrincipal] = useState("");
  const [newLevel, setNewLevel] = useState<PermissionLevel>("read_only");

  const refresh = () => {
    setError(null);
    listPermissions()
      .then(setPermissions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    refresh();
  }, []);

  const changeLevel = async (principal: string, level: PermissionLevel) => {
    setBusy(true);
    setActionError(null);
    try {
      await setPermission(principal, level);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (principal: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await removePermission(principal);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async () => {
    const principal = newPrincipal.trim();
    if (!principal) return;
    setBusy(true);
    setActionError(null);
    try {
      await setPermission(principal, newLevel);
      setNewPrincipal("");
      setNewLevel("read_only");
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="h-14 flex-shrink-0 flex items-center justify-between px-4 border-b border-[#1e2d47]">
        <div className="flex items-center gap-2 min-w-0">
          <Shield size={14} className="text-[#00d4ff] flex-shrink-0" />
          <span className="text-sm font-semibold text-[#e2e8f0]">Permissions</span>
        </div>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto">
        <p className="text-xs text-[#4a5568]">
          Explicit per-principal access to this database. A principal with no entry here falls back to this
          canister's default - anonymous callers are read-only; anyone else is read-write, unless an auth canister
          is configured. Changing entries requires a controller.
        </p>

        {actionError && <p className="text-xs text-[#ff5252] px-3 py-2 rounded bg-[#ff525211] border border-[#ff525233]">{actionError}</p>}

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-[11px] text-[#8892a4] mb-1">Principal</label>
            <Input
              value={newPrincipal}
              onChange={(e) => setNewPrincipal(e.target.value)}
              placeholder="aaaaa-aa…"
              className="text-xs h-8 font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] text-[#8892a4] mb-1">Access</label>
            <Select
              value={newLevel}
              onChange={(next) => setNewLevel(next as PermissionLevel)}
              triggerClassName="h-8 px-2 text-xs"
              options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
            />
          </div>
          <Button variant="primary" size="sm" onClick={addEntry} disabled={busy || !newPrincipal.trim()}>
            <Plus size={13} /> Add
          </Button>
        </div>

        {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        {!error && permissions === null && <p className="text-xs text-[#4a5568]">Loading…</p>}
        {!error && permissions && permissions.length === 0 && (
          <p className="text-xs text-[#4a5568]">No explicit entries - every caller uses this canister's default.</p>
        )}

        {!error && permissions && permissions.length > 0 && (
          <div className="border border-[#1e2d47] rounded-lg overflow-hidden">
            {permissions.map((p) => (
              <div key={p.principal} className="flex items-center gap-3 px-3 py-2.5 border-b border-[#1e2d47] last:border-0 hover:bg-[#0f1629] transition-colors">
                <span className="text-xs font-mono text-[#e2e8f0] truncate flex-1" title={p.principal}>{p.principal}</span>
                <Badge variant={levelMeta(p.level).variant}>{levelMeta(p.level).label}</Badge>
                <Select
                  value={p.level}
                  onChange={(next) => changeLevel(p.principal, next as PermissionLevel)}
                  disabled={busy}
                  triggerClassName="h-7 px-1.5 text-[11px]"
                  options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
                />
                <button
                  onClick={() => remove(p.principal)}
                  disabled={busy}
                  title="Remove entry"
                  className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#ff5252] transition-colors disabled:opacity-40"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
