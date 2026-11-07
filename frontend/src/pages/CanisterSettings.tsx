// "The canister setting page fetches config schema and renders it as a
// Form" (the user's own framing) - `/project/:id/canister/:canisterId/settings`,
// reached from the "Edit Settings" action on that canister's card in
// Overview.tsx. Fetches `get_config_schema`/`get_config` directly from the
// canister (no orchestrator involved, matching every other direct-to-canister
// page in this dashboard) and renders the schema via `ConfigForm`.

import { useEffect, useState } from "react";
import { useOutletContext, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { CanisterID } from "@/components/CanisterID";
import { ConfigForm } from "@/components/ConfigForm";
import { toast } from "@/components/Toast";
import type { ProjectContext } from "@/components/layout/AppShell";
import { getModuleConfigSchema, getModuleConfig, setModuleConfig, type ConfigFieldSchema, type ConfigValue } from "@/lib/moduleConfig";

export default function CanisterSettings() {
  const { job, loadError, refetch } = useOutletContext<ProjectContext>();
  const { canisterId } = useParams<{ canisterId: string }>();
  const navigate = useNavigate();

  const [schema, setSchema] = useState<ConfigFieldSchema[] | null>(null);
  const [config, setConfig] = useState<Record<string, ConfigValue> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const entry = job && canisterId ? Object.entries(job.canisters).find(([, info]) => info.id === canisterId) : undefined;
  const canisterName = entry?.[0] ?? canisterId;

  useEffect(() => {
    if (!job || !canisterId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      getModuleConfigSchema(canisterId, job.network),
      getModuleConfig(canisterId, job.network),
    ])
      .then(([s, c]) => {
        setSchema(s);
        setConfig(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [job, canisterId]);

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const handleSave = async (changed: Record<string, ConfigValue>) => {
    if (!canisterId) return;
    await setModuleConfig(canisterId, job.network, changed);
    const refreshed = await getModuleConfig(canisterId, job.network);
    setConfig(refreshed);
    toast.success("Settings saved", `${canisterName}'s configuration was updated.`);
  };
  const installedCanisters = Object.fromEntries(
    Object.entries(job.canisters).map(([name, info]) => [name, {
      id: info.id,
      kind: info.kind,
      packageName: info.packageName,
    }]),
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <button
        onClick={() => navigate(`/project/${job.id}/overview`)}
        className="flex items-center gap-1.5 text-xs text-[#4a5568] hover:text-[#00d4ff] transition-colors"
      >
        <ArrowLeft size={12} /> Back to Overview
      </button>

      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-md bg-[#1a2236] border border-[#1e2d47] flex items-center justify-center flex-shrink-0">
          <SettingsIcon size={14} className="text-[#00d4ff]" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-[#e2e8f0]">{canisterName} Settings</h2>
          {canisterId && <CanisterID id={canisterId} className="text-[10px]" showFull />}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-[#4a5568]">Loading configuration…</p>}
          {!loading && error && (
            <p className="text-sm text-[#ff5252]">
              This canister doesn't expose dynamic settings, or it couldn't be reached ({error}).
            </p>
          )}
          {!loading && !error && schema && config && (
            <ConfigForm
              schema={schema}
              initialValues={config}
              installedCanisters={installedCanisters}
              projectId={job.id}
              network={job.network}
              onCanisterInstalled={() => refetch()}
              onSubmit={handleSave}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
