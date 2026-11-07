import { useRef, useState, type ReactNode } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { Principal } from "@icp-sdk/core/principal";
import { Cpu, Upload, RefreshCw, GitBranch, Trash2, Loader2, Sparkles, ExternalLink, Link2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/Toast";
import { clsx } from "clsx";
import type { ProjectContext } from "@/components/layout/AppShell";
import { useAuth } from "@/lib/auth";
import { listRuntimeCanisters, deployWasmRuntime, upgradeWasmRuntime, attachRuntimeCanister, type RuntimeCanister, type UpdateMode } from "@/lib/runtime";
import { removeProjectCanister } from "@/lib/backend";
import { deleteCanister } from "@/lib/canisterOps";

function readWasmFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file"));
    reader.readAsArrayBuffer(file);
  });
}

/** Fetches raw wasm bytes from a URL the browser can reach directly - no
 * server-side proxy, so this only works for a URL that actually sends
 * CORS headers permitting it (a real, disclosed limitation, same spirit as
 * `lib/deploy.ts`'s own marketplace-fetch doc comment). Gzip-compressed
 * wasm needs no special handling: the IC's own `install_code` already
 * accepts gzip-compressed modules directly by their magic bytes, same as
 * a `.wasm.gz` file upload already does. */
async function fetchWasmFromUrl(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching ${url} failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Strips a trailing `.wasm`/`.wasm.gz` extension - used to turn either a
 * picked file's name or a URL's last path segment into a human label for
 * `deployWasmRuntime`. */
function wasmLabelFrom(name: string): string {
  return name.replace(/\.wasm(\.gz)?$/i, "");
}

/** A small pill-style two-option switch - shared by `WasmSourcePicker`'s
 * file/URL choice and `DeployOrUpdateCard`'s upgrade/reinstall choice, so
 * both look and behave identically instead of two near-duplicate
 * hand-rolled button rows. */
function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div className="flex w-full gap-1 p-1 rounded-lg border border-[#1e2d47] bg-[#0a0e1a]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors text-center",
            value === opt.value
              ? "bg-[#00d4ff1a] text-[#00d4ff] ring-1 ring-inset ring-[#00d4ff44]"
              : "text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#ffffff08]"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Lets the caller get wasm bytes either from a local file or a URL this
 * browser fetches directly - the one real difference between the two
 * paths `DeployOrUpdateCard` otherwise shares for deploy vs. update.
 * `busy` covers the *caller's* own follow-up work (deploy/upgrade/
 * reinstall), so the button stays in a loading state across both the
 * fetch (URL mode) and whatever happens after. */
function WasmSourcePicker({
  busy,
  disabled,
  actionLabel,
  busyLabel,
  onWasm,
}: {
  busy: boolean;
  /** Non-interactive without the busy spinner/label. Distinct from `busy`:
   * this never changes what the button shows, only whether it (and the
   * URL input) responds. */
  disabled?: boolean;
  actionLabel: string;
  busyLabel: string;
  /** `label` is the picked file's name, or a URL's last path segment,
   * extension stripped - empty if neither could produce one (e.g. a URL
   * with no path), which callers that don't need a label can just ignore. */
  onWasm: (wasm: Uint8Array, label: string) => void;
}) {
  const [mode, setMode] = useState<"file" | "url">("file");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    readWasmFile(file)
      .then((wasm) => onWasm(wasm, wasmLabelFrom(file.name)))
      .catch((e) => toast.error("Couldn't read file", e instanceof Error ? e.message : String(e)));
  };

  const submitUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    try {
      const wasm = await fetchWasmFromUrl(trimmed);
      const lastSegment = (() => {
        try {
          return new URL(trimmed).pathname.split("/").pop() ?? "";
        } catch {
          return "";
        }
      })();
      onWasm(wasm, wasmLabelFrom(lastSegment));
    } catch (e) {
      toast.error("Fetch failed", e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const isBusy = busy || fetching;
  const isDisabled = isBusy || disabled;

  return (
    <div className="space-y-2">
      <SegmentedTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: "file", label: "Upload file" },
          { value: "url", label: "From URL" },
        ]}
      />

      {mode === "file" ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".wasm,.wasm.gz"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="primary"
            size="md"
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled}
            className="w-full justify-center"
          >
            {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {isBusy ? busyLabel : actionLabel}
          </Button>
        </>
      ) : (
        <div className="space-y-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/module.wasm"
            disabled={isDisabled}
            className="w-full px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none focus:border-[#00d4ff55]"
          />
          <Button
            variant="primary"
            size="md"
            onClick={submitUrl}
            disabled={isDisabled || !url.trim()}
            className="w-full justify-center"
          >
            {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
            {isBusy ? busyLabel : actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Runtime" - upload/deploy a compiled wasm directly, attach a canister
 * this project didn't deploy, or hand a git repo off to the Secretary to
 * clone/build/deploy (the user's own framing: "similar to Supabase Edge
 * [Functions]"). Three real, independent pieces:
 *
 * 1. Wasm upload/deploy/upgrade - Cycles Ledger canister creation followed
 *    by a genuine `aaaaa-aa.install_code` from the browser (see
 *    `lib/runtime.ts`). Fully real, no orchestrator involved.
 * 2. Attach an existing canister (`AttachCanisterCard`) - no deploy at all,
 *    just starts tracking an id the user already controls elsewhere
 *    (`lib/runtime.ts::attachRuntimeCanister`), gated on a live
 *    `read_state` controller check, not a self-reported claim.
 * 3. "Connect a git repository" - there's no webhook/CI infrastructure in
 *    this codebase to watch a repo and rebuild on push, so this doesn't
 *    pretend to be one. It hands the repo URL/branch to the real AI
 *    Secretary (`Orchestrate.tsx`), which genuinely knows how to check out,
 *    build with icp-cli, and deploy a project (see the
 *    `icp-cli-multi-canister-assembly` project notes) - a real, working
 *    action, just user-triggered per build rather than push-triggered.
 */
export default function RuntimePage() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const { principal } = useAuth();
  const navigate = useNavigate();

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <Cpu size={18} className="text-[#00d4ff]" /> Runtime
          </h2>
          <p className="text-sm text-[#4a5568] mt-1">Deploy a compiled canister wasm directly - from a local file or a URL.</p>
        </div>
        <Button variant="secondary" onClick={refetch}>
          <RefreshCw size={13} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <DeployOrUpdateCard job={job} principal={principal} refetch={refetch} navigate={navigate} />
        <AttachCanisterCard job={job} principal={principal} refetch={refetch} navigate={navigate} />
        {/* Connect-a-git-repository is on hold for now - there's no
            push-triggered CI to back it yet, see `GitRuntimeCard`'s own doc
            comment. Commented out rather than deleted since the Secretary
            hand-off it builds on is real and already works.
        <GitRuntimeCard projectId={job.id} navigate={navigate} /> */}
      </div>
    </div>
  );
}

/** One unified deploy/update control, per the user's own instruction: "The
 * Canister selection and Upload UI should be 1" - a single canister
 * selector (defaulting to "New canister") plus a single `WasmSourcePicker`
 * decide what happens on submit:
 *
 * - Selection left on "New canister" (the default, `selectedName === ""`):
 *   submitting a file/URL deploys a brand-new canister, exactly like the
 *   old standalone deploy card did.
 * - An existing canister selected: submitting instead pushes the wasm onto
 *   *that* canister, as either an `"upgrade"` (state preserved - the
 *   default) or a `"reinstall"` (stable memory wiped) per the toggle below
 *   the selector - the user's own distinction, surfaced here rather than
 *   silently always upgrading.
 *
 * Also still lists this project's `"runtime-"`-prefixed canisters below,
 * each with just a Remove action now - redeploying one is the same
 * selector+upload flow above, not a separate per-row control. */
function DeployOrUpdateCard({
  job,
  principal,
  refetch,
  navigate,
}: {
  job: NonNullable<ProjectContext["job"]>;
  principal: string | null;
  refetch: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [selectedName, setSelectedName] = useState("");
  const [updateMode, setUpdateMode] = useState<UpdateMode>("upgrade");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const runtimeCanisters = listRuntimeCanisters(job);
  const canisterEntries = Object.entries(job.canisters).sort(([a], [b]) => a.localeCompare(b));
  const selected = selectedName ? job.canisters[selectedName] : undefined;
  const isNewCanister = selectedName === "";

  const handleWasm = async (wasm: Uint8Array, label: string) => {
    if (isNewCanister) {
      if (!principal) {
        toast.error("Not signed in", "Sign in again and retry.");
        return;
      }
      setBusy(true);
      try {
        const result = await deployWasmRuntime(label, wasm, job.network, job.id, Principal.fromText(principal));
        toast.success(`${result.name} deployed`, `Runtime canister ${result.id} is live.`);
        refetch();
        if (result.hasConfig) {
          navigate(`/project/${job.id}/canister/${result.id}/settings`);
        }
      } catch (e) {
        toast.error("Deploy failed", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!selected) {
      toast.error("Pick a canister", "Choose which canister to update, or leave it on \"New canister\" to deploy a fresh one.");
      return;
    }
    setBusy(true);
    try {
      await upgradeWasmRuntime(selected.id, wasm, job.network, updateMode, job.id);
      toast.success(
        updateMode === "reinstall" ? "Reinstalled" : "Upgraded",
        updateMode === "reinstall" ? `${selectedName} is running the new wasm - its previous state was wiped.` : `${selectedName} is running the new wasm.`
      );
      refetch();
    } catch (e) {
      toast.error(updateMode === "reinstall" ? "Reinstall failed" : "Upgrade failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (canister: RuntimeCanister) => {
    setRemovingId(canister.id);
    try {
      await deleteCanister(canister.id, job.network);
      await removeProjectCanister(job.id, canister.name);
      toast.success("Removed", `${canister.name} was stopped and deleted.`);
      refetch();
    } catch (e) {
      toast.error("Couldn't remove canister", e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload size={14} className="text-[#00d4ff]" /> Deploy or Update a Canister
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[#4a5568]">
          Pick a canister to push a new wasm build onto it, or leave this on <span className="font-mono">New canister</span> to deploy a fresh
          one on <span className="font-mono">{job.network}</span> - from a local file or fetched directly from a URL.
        </p>
        <div className="space-y-2.5 rounded-lg border border-[#1e2d47] bg-[#0a0e1a66] p-3">
          <label className="block">
            <span className="text-[11px] text-[#8892a4]">Target canister</span>
            <div className="mt-1">
              <Select
                value={selectedName}
                onChange={setSelectedName}
                options={[
                  { value: "", label: "New canister" },
                  ...canisterEntries.map(([name, info]) => ({ value: name, label: `${name} (${info.kind})` })),
                ]}
              />
            </div>
          </label>

          {selected && (
            <>
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[#0a0e1a] border border-[#1e2d47]">
                <Cpu size={12} className="text-[#00d4ff] flex-shrink-0" />
                <span className="text-[10px] text-[#4a5568] font-mono truncate">{selected.id}</span>
              </div>
              <SegmentedTabs
                value={updateMode}
                onChange={setUpdateMode}
                options={[
                  { value: "upgrade", label: <>Upgrade <span className="opacity-70">(keep data)</span></> },
                  { value: "reinstall", label: <>Reinstall <span className="opacity-70">(wipe data)</span></> },
                ]}
              />
              {updateMode === "reinstall" && (
                <p className="text-[10px] text-[#ff5252]">This wipes {selectedName}'s stable memory - its own data is gone, not just its code.</p>
              )}
            </>
          )}
        </div>

        <WasmSourcePicker
          busy={busy}
          actionLabel={isNewCanister ? "Deploy" : updateMode === "reinstall" ? "Reinstall" : "Upgrade"}
          busyLabel={isNewCanister ? "Deploying…" : updateMode === "reinstall" ? "Reinstalling…" : "Upgrading…"}
          onWasm={handleWasm}
        />

        <div className="pt-1">
          {runtimeCanisters.length === 0 ? (
            <p className="text-xs text-[#4a5568] py-3 border-t border-[#1e2d47]">No runtime canisters deployed yet.</p>
          ) : (
            <div className="border-t border-[#1e2d47] -mx-4 mt-1">
              {runtimeCanisters.map((c) => (
                <RuntimeRow key={c.id} canister={c} busy={removingId === c.id} onRemove={() => handleRemove(c)} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RuntimeRow({
  canister,
  busy,
  onRemove,
}: {
  canister: RuntimeCanister;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#1e2d47] last:border-0 hover:bg-[#131929] transition-colors">
      <div className="w-7 h-7 rounded-lg bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center flex-shrink-0">
        <Cpu size={13} className="text-[#00d4ff]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[#e2e8f0] truncate">{canister.name}</div>
        <div className="text-[10px] text-[#4a5568] font-mono truncate">{canister.id}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} className="text-[#ff5252] hover:bg-[#ff525211]">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
      </Button>
    </div>
  );
}

/** Tracks an existing canister this project didn't deploy - gated on a real,
 * live controller check (`attachRuntimeCanister`), not just whatever id the
 * user happens to type in. Deliberately its own card rather than a third
 * option on `DeployOrUpdateCard`'s selector: that selector picks *which
 * already-tracked canister* to push a wasm onto, which is a different
 * question from "start tracking a canister this project doesn't know about
 * yet" - conflating the two would mean a wasm picker shown for an action
 * that doesn't install anything at all. */
function AttachCanisterCard({
  job,
  principal,
  refetch,
  navigate,
}: {
  job: NonNullable<ProjectContext["job"]>;
  principal: string | null;
  refetch: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [canisterId, setCanisterId] = useState("");
  const [label, setLabel] = useState("");
  const [attaching, setAttaching] = useState(false);

  const attach = async () => {
    if (!principal) {
      toast.error("Not signed in", "Sign in again and retry.");
      return;
    }
    if (!canisterId.trim()) return;
    setAttaching(true);
    try {
      const result = await attachRuntimeCanister(canisterId.trim(), label.trim(), job.network, job, Principal.fromText(principal));
      toast.success(`${result.name} attached`, `${result.id} is now tracked on this project.`);
      setCanisterId("");
      setLabel("");
      refetch();
      if (result.hasConfig) {
        navigate(`/project/${job.id}/canister/${result.id}/settings`);
      }
    } catch (e) {
      toast.error("Couldn't attach canister", e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 size={14} className="text-[#00d4ff]" /> Attach an Existing Canister
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[#4a5568]">
          Start tracking a canister this project didn't deploy - allowed only if your signed-in principal is already one of its real controllers,
          checked live against the network, not something you can get around by just pasting any id.
        </p>
        <label className="block">
          <span className="text-[11px] text-[#8892a4]">Canister ID</span>
          <input
            value={canisterId}
            onChange={(e) => setCanisterId(e.target.value)}
            placeholder="xxxxx-xxxxx-xxxxx-xxxxx-cai"
            disabled={attaching}
            className="mt-1 w-full px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg text-sm text-[#e2e8f0] placeholder-[#4a5568] font-mono outline-none focus:border-[#00d4ff55]"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-[#8892a4]">Name (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="my-service"
            disabled={attaching}
            className="mt-1 w-full px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none focus:border-[#00d4ff55]"
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          onClick={attach}
          disabled={attaching || !canisterId.trim()}
          className="w-full justify-center gap-1.5"
        >
          {attaching ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
          {attaching ? "Attaching…" : "Attach"}
        </Button>
      </CardContent>
    </Card>
  );
}

function GitRuntimeCard({ projectId, navigate }: { projectId: string; navigate: ReturnType<typeof useNavigate> }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");

  const connect = () => {
    if (!repoUrl.trim()) return;
    const seed = `Connect this project's Runtime to the git repository ${repoUrl.trim()} (branch "${branch.trim() || "main"}") - clone it, build it with icp-cli, and deploy it as a canister.`;
    navigate(`/project/${projectId}/orchestrate`, { state: { seed } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch size={14} className="text-[#c084fc]" /> Connect a Git Repository
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[#4a5568]">
          There's no push-triggered CI in this dashboard yet, so this doesn't silently watch your repo in the background. Instead it hands the
          repo straight to the Secretary, which really does clone, build with icp-cli, and deploy it - you trigger a build whenever you want one.
        </p>
        <div className="space-y-2">
          <label className="block">
            <span className="text-[11px] text-[#8892a4]">Repository URL</span>
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              className="mt-1 w-full px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none focus:border-[#00d4ff55]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[#8892a4]">Branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="mt-1 w-full px-3 py-2 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none focus:border-[#00d4ff55]"
            />
          </label>
        </div>
        <Button variant="primary" size="sm" onClick={connect} disabled={!repoUrl.trim()} className="gap-1.5">
          <Sparkles size={13} /> Connect &amp; Build with Secretary
        </Button>
        <a
          href="https://cli.internetcomputer.org/llms.txt"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-[#4a5568] hover:text-[#00d4ff]"
        >
          icp-cli build docs <ExternalLink size={10} />
        </a>
      </CardContent>
    </Card>
  );
}
