import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Boxes, CheckCircle2, Circle, Loader, Rocket, XCircle } from "lucide-react";
import { Principal } from "@icp-sdk/core/principal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { ToastProvider, toast } from "@/components/Toast";
import { Footer } from "@/components/layout/Footer";
import { useAuth } from "@/lib/auth";
import { createProject, setProjectName } from "@/lib/backend";
import { runtimeNetwork } from "@/lib/canisterEnv";
import type { ConfigFieldSchema, ConfigType, ConfigValue } from "@/lib/moduleConfig";
import {
  applyPackageConfig,
  getPackageConfigPlan,
  activePackages,
  getTemplate,
  installTemplatePackage,
  recordTemplateDownload,
  type PackageConfigPlan,
  type ProjectTemplate,
  type TemplatePackage,
} from "@/lib/templates";

type PackageStatus = "pending" | "installing" | "awaiting_input" | "configuring" | "done" | "error";

/** A scalar (non-`Vector`) `ConfigType`, which is all this page prompts
 * for - see this file's own note on `promptableFields` for why a required
 * `Vector` field is a disclosed, not silently skipped, limitation here. */
type ScalarConfigType = Exclude<ConfigType, { Vector: unknown }>;

function isTextLike(fieldType: ScalarConfigType): boolean {
  return "Text" in fieldType || "TextArea" in fieldType || "SecretText" in fieldType || "Select" in fieldType;
}

function rawToScalarConfigValue(fieldType: ScalarConfigType, raw: string | boolean): ConfigValue | null {
  if (isTextLike(fieldType)) return { Text: String(raw) };
  if ("Number" in fieldType) {
    const n = Number(raw);
    return Number.isFinite(n) && Number.isInteger(n) ? { Number: BigInt(n) } : null;
  }
  if ("Float" in fieldType) {
    const n = Number(raw);
    return Number.isFinite(n) ? { Float: n } : null;
  }
  if ("Boolean" in fieldType) return { Boolean: Boolean(raw) };
  if ("CanisterPicker" in fieldType) {
    try {
      return { PrincipalId: Principal.fromText(String(raw).trim()) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Only the scalar fields a `PackageConfigPlan.missingRequired` list can
 * actually be prompted for on this page - a required `Vector` field (rare:
 * a template package needing a *list* with no default, unfilled by the
 * manifest) is left for the project's own Settings page after deploy
 * instead of building list-editing UI into a one-shot install wizard. */
function promptableFields(fields: ConfigFieldSchema[]): ConfigFieldSchema[] {
  return fields.filter((field) => !("Vector" in field.field_type));
}

interface ConfigPromptProps {
  pkg: TemplatePackage;
  plan: PackageConfigPlan;
  onSubmit: (values: Record<string, ConfigValue>) => void;
}

/** One inline form per package that still needs required values the
 * manifest didn't already supply - blocks the install sequence until
 * submitted (see `TemplateInstall`'s `promptForConfig`). */
function ConfigPrompt({ pkg, plan, onSubmit }: ConfigPromptProps) {
  const promptable = promptableFields(plan.missingRequired);
  const unsupported = plan.missingRequired.filter((field) => "Vector" in field.field_type);
  const [raw, setRaw] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(promptable.map((field) => [field.key, "Boolean" in field.field_type ? false : ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const values: Record<string, ConfigValue> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of promptable) {
      const value = raw[field.key];
      if (!("Boolean" in field.field_type) && String(value).trim() === "") {
        nextErrors[field.key] = "Required";
        continue;
      }
      const converted = rawToScalarConfigValue(field.field_type as ScalarConfigType, value);
      if (converted === null) {
        nextErrors[field.key] = "CanisterPicker" in field.field_type ? "Not a valid canister id" : "Not a valid value";
        continue;
      }
      values[field.key] = converted;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSubmit(values);
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-[#f6c85f44] bg-[#f6c85f0a] p-4 space-y-3">
      <p className="text-xs text-[#f6c85f]">
        <code>{pkg.name}</code> needs a few values before it can be configured.
      </p>
      {promptable.map((field) => {
        const fieldType = field.field_type as ScalarConfigType;
        const value = raw[field.key];
        const inputId = `template-config-${pkg.name}-${field.key}`;
        return (
          <div key={field.key}>
            <Label htmlFor={inputId}>{field.label} <span className="text-[#ff5252]">*</span></Label>
            {"Boolean" in fieldType ? (
              <Toggle checked={Boolean(value)} onChange={(next) => setRaw((prev) => ({ ...prev, [field.key]: next }))} />
            ) : "Select" in fieldType ? (
              <Select
                id={inputId}
                value={String(value)}
                onChange={(next) => setRaw((prev) => ({ ...prev, [field.key]: next }))}
                placeholder="Select…"
                options={fieldType.Select.options.map((option) => ({ value: option, label: option }))}
              />
            ) : "TextArea" in fieldType ? (
              <Textarea
                id={inputId}
                rows={5}
                className="font-mono"
                value={String(value)}
                onChange={(e) => setRaw((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            ) : (
              <Input
                id={inputId}
                type={"SecretText" in fieldType ? "password" : "Number" in fieldType || "Float" in fieldType ? "number" : "text"}
                value={String(value)}
                onChange={(e) => setRaw((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            )}
            {field.description && <p className="text-[10px] text-[#4a5568] mt-1">{field.description}</p>}
            {errors[field.key] && <p className="text-[10px] text-[#ff5252] mt-1">{errors[field.key]}</p>}
          </div>
        );
      })}
      {unsupported.length > 0 && (
        <p className="text-[10px] text-[#f6c85f]">
          {unsupported.map((f) => f.label).join(", ")} also require a value but need to be set from this canister's own Settings page after deploy.
        </p>
      )}
      <Button type="submit" variant="primary" size="sm">Continue</Button>
    </form>
  );
}

interface PackageRowState {
  pkg: TemplatePackage;
  status: PackageStatus;
  canisterId?: string;
  error?: string;
}

const STATUS_ICON: Record<PackageStatus, ReactNode> = {
  pending: <Circle size={14} className="text-[#4a5568]" />,
  installing: <Loader size={14} className="animate-spin text-[#00d4ff]" />,
  awaiting_input: <Circle size={14} className="text-[#f6c85f]" />,
  configuring: <Loader size={14} className="animate-spin text-[#00d4ff]" />,
  done: <CheckCircle2 size={14} className="text-[#00e676]" />,
  error: <XCircle size={14} className="text-[#ff5252]" />,
};

export default function TemplateInstall() {
  const { slug: itemId = "" } = useParams();
  const navigate = useNavigate();
  const { principal } = useAuth();
  const [template, setTemplate] = useState<ProjectTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectNameInput] = useState("");
  const [deploying, setDeploying] = useState(false);
  // Optional packages the user has switched off; absent means kept.
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<PackageRowState[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<{ pkg: TemplatePackage; plan: PackageConfigPlan } | null>(null);
  const resolvePromptRef = useRef<((values: Record<string, ConfigValue>) => void) | null>(null);

  useEffect(() => {
    getTemplate(itemId)
      .then((value) => { setTemplate(value); setProjectNameInput(value.template.slug); })
      .catch((e) => setError(String(e)));
  }, [itemId]);

  function promptForConfig(pkg: TemplatePackage, plan: PackageConfigPlan): Promise<Record<string, ConfigValue>> {
    return new Promise((resolve) => {
      resolvePromptRef.current = resolve;
      setPendingPrompt({ pkg, plan });
    });
  }

  const submitPrompt = (values: Record<string, ConfigValue>) => {
    setPendingPrompt(null);
    resolvePromptRef.current?.(values);
    resolvePromptRef.current = null;
  };

  const activeNames = new Set((template ? activePackages(template.packages, enabled) : []).map((pkg) => pkg.name));

  const deploy = async () => {
    if (!template || !principal) {
      if (!principal) toast.error("Not signed in", "Sign in and retry.");
      return;
    }
    const network = runtimeNetwork() === "ic" ? "ic" : "local";
    const userPrincipal = Principal.fromText(principal);
    const ordered = activePackages(template.packages, enabled);
    setRows(ordered.map((pkg) => ({ pkg, status: "pending" })));
    setDeploying(true);

    const setStatus = (name: string, patch: Partial<PackageRowState>) => {
      setRows((prev) => prev.map((row) => (row.pkg.name === name ? { ...row, ...patch } : row)));
    };

    try {
      const projectId = await createProject(`Deployed from template "${template.template.name}"`, network);
      await setProjectName(projectId, projectName);
      await recordTemplateDownload(itemId);

      const canisterIds: Record<string, string> = {};
      for (const pkg of ordered) {
        setStatus(pkg.name, { status: "installing" });
        const installed = await installTemplatePackage(pkg, network, userPrincipal, projectId);
        canisterIds[pkg.name] = installed.canisterId;
        setStatus(pkg.name, { canisterId: installed.canisterId });

        const plan = await getPackageConfigPlan(network, installed.canisterId, pkg, template, canisterIds, projectId);
        let values = plan.prefill;
        if (plan.missingRequired.length > 0) {
          setStatus(pkg.name, { status: "awaiting_input" });
          const submitted = await promptForConfig(pkg, plan);
          values = { ...plan.prefill, ...submitted };
        }

        setStatus(pkg.name, { status: "configuring" });
        await applyPackageConfig(network, installed.canisterId, values);
        setStatus(pkg.name, { status: "done" });
      }

      toast.success("Template deployed", `"${projectName}" is ready.`);
      navigate(`/project/${projectId}/overview`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRows((prev) => prev.map((row) => (row.status === "done" ? row : { ...row, status: row.status === "pending" ? row.status : "error", error: row.status === "pending" ? row.error : message })));
      toast.error("Deployment failed", message);
    } finally {
      setDeploying(false);
    }
  };

  return <div className="min-h-screen bg-[#0a0e1a] text-[#e2e8f0]">
    <header className="h-12 flex items-center px-6 border-b border-[#1e2d47]">
      <button onClick={() => navigate("/marketplace")} className="flex items-center gap-2 text-sm text-[#8892a4] hover:text-white"><ArrowLeft size={15}/> Marketplace</button>
    </header>
    <main className="max-w-4xl mx-auto px-6 py-10">
      {error && <div className="p-4 border border-red-500/30 rounded-xl text-red-300">{error}</div>}
      {!template && !error && <Loader className="animate-spin text-[#00d4ff]"/>}
      {template && <div className="space-y-8">
        <div className="flex gap-5"><div className="w-16 h-16 rounded-2xl bg-[#c084fc18] border border-[#c084fc44] flex items-center justify-center"><Boxes className="text-[#c084fc]"/></div>
          <div><div className="flex items-center gap-2"><h1 className="text-2xl font-bold">{template.template.name}</h1><Badge variant="gray">v{template.template.version}</Badge></div><p className="text-sm text-[#8892a4] mt-2">{template.template.description}</p></div>
        </div>
        <section className="rounded-xl border border-[#1e2d47] bg-[#0f1629] p-5"><h2 className="text-sm font-semibold mb-4">Architecture</h2><div className="space-y-3">
          {template.packages.map((pkg) => {
            const row = rows.find((r) => r.pkg.name === pkg.name);
            const included = activeNames.has(pkg.name);
            const blockedBy = pkg.depends_on.find((dep) => !activeNames.has(dep));
            return (
              <div key={pkg.name} className={`flex items-center gap-3 p-3 rounded-lg bg-[#0a0e1a] ${included ? "" : "opacity-60"}`}>
                {!pkg.required && !deploying ? (
                  <input
                    type="checkbox"
                    aria-label={`Install ${pkg.name}`}
                    checked={included}
                    disabled={blockedBy !== undefined}
                    onChange={(e) => setEnabled((prev) => ({ ...prev, [pkg.name]: e.target.checked }))}
                    className="accent-[#00d4ff]"
                  />
                ) : row ? STATUS_ICON[row.status] : <CheckCircle2 size={14} className="text-[#00e676]" />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{!pkg.required && pkg.prompt ? pkg.prompt : pkg.name}</div>
                  <div className="text-[11px] text-[#4a5568] truncate">
                    {row?.error ?? (included ? null : blockedBy ? `Skipped - needs ${blockedBy}` : "Skipped") ?? `${pkg.url}${pkg.depends_on.length ? ` · after ${pkg.depends_on.join(", ")}` : ""}`}
                  </div>
                </div>
                <Badge variant="gray">{pkg.required ? "required" : "optional"}</Badge>
              </div>
            );
          })}
        </div></section>

        {pendingPrompt && <ConfigPrompt pkg={pendingPrompt.pkg} plan={pendingPrompt.plan} onSubmit={submitPrompt} />}

        <section className="rounded-xl border border-[#1e2d47] bg-[#0f1629] p-5 space-y-4"><h2 className="text-sm font-semibold">Deploy project</h2>
          <label className="block text-xs text-[#8892a4]">Project name<input value={projectName} onChange={(e) => setProjectNameInput(e.target.value)} disabled={deploying} className="mt-2 w-full rounded-lg border border-[#1e2d47] bg-[#0a0e1a] px-3 py-2 text-sm text-white outline-none focus:border-[#00d4ff]"/></label>
          <Button variant="primary" onClick={deploy} disabled={deploying || !projectName} className="gap-2">{deploying ? <Loader size={13} className="animate-spin"/> : <Rocket size={13}/>} {deploying ? "Deploying…" : "Deploy template"}</Button>
        </section>
      </div>}
    </main>
    <Footer />
    <ToastProvider/></div>;
}
