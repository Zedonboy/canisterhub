import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Boxes, CheckCircle2, Loader, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ToastProvider, toast } from "@/components/Toast";
import { Footer } from "@/components/layout/Footer";
import { deployTemplate, getTemplate, type ProjectTemplate } from "@/lib/templates";
import { runtimeNetwork } from "@/lib/canisterEnv";

export default function TemplateInstall() {
  const { slug: itemId = "" } = useParams();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<ProjectTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    getTemplate(itemId)
      .then((value) => { setTemplate(value); setProjectName(value.template.slug); })
      .catch((e) => setError(String(e)));
  }, [itemId]);

  const deploy = async () => {
    setDeploying(true);
    try {
      const jobId = await deployTemplate(itemId, projectName, runtimeNetwork() === "ic" ? "ic" : "local");
      toast.success("Template deployment started", `Job ${jobId.slice(0, 8)} is deploying the architecture.`);
    } catch (e) { toast.error("Deployment failed", e instanceof Error ? e.message : String(e)); }
    finally { setDeploying(false); }
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
        <section className="rounded-xl border border-[#1e2d47] bg-[#0f1629] p-5"><h2 className="text-sm font-semibold mb-4">Architecture</h2><div className="space-y-3">{template.packages.map((pkg) => <div key={pkg.name} className="flex items-center gap-3 p-3 rounded-lg bg-[#0a0e1a]"><CheckCircle2 size={14} className="text-[#00e676]"/><div className="flex-1 min-w-0"><div className="text-sm">{pkg.name}</div><div className="text-[11px] text-[#4a5568] truncate">{pkg.url}{pkg.depends_on.length ? ` · after ${pkg.depends_on.join(", ")}` : ""}</div></div><Badge variant="gray">{pkg.required ? "required" : "optional"}</Badge></div>)}</div></section>
        <section className="rounded-xl border border-[#1e2d47] bg-[#0f1629] p-5 space-y-4"><h2 className="text-sm font-semibold">Deploy project</h2>
          <label className="block text-xs text-[#8892a4]">Project name<input value={projectName} onChange={(e) => setProjectName(e.target.value)} className="mt-2 w-full rounded-lg border border-[#1e2d47] bg-[#0a0e1a] px-3 py-2 text-sm text-white outline-none focus:border-[#00d4ff]"/></label>
          <Button variant="primary" onClick={deploy} disabled={deploying || !projectName} className="gap-2">{deploying ? <Loader size={13} className="animate-spin"/> : <Rocket size={13}/>} {deploying ? "Starting…" : "Deploy template"}</Button>
        </section>
      </div>}
    </main>
    <Footer />
    <ToastProvider/></div>;
}
