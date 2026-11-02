import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Compass } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Shown for any path no route matches. Rendered both app-wide and inside a
 * project (so the sidebar stays visible there): with a project id in the
 * URL the way back is that project's Overview, otherwise the dashboard. */
export default function NotFound() {
  const { id: projectId } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const home = projectId ? `/project/${projectId}/overview` : "/dashboard";

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-16 bg-[#0a0e1a] text-[#e2e8f0]">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-[#00d4ff18] border border-[#00d4ff44] flex items-center justify-center">
          <Compass className="text-[#00d4ff]" size={26} />
        </div>
        <p className="text-xs font-mono text-[#4a5568]">404</p>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-[#8892a4]">
          There's nothing at <code className="font-mono text-[#e2e8f0] break-all">{pathname}</code>. The link may be
          mistyped, or the page may have moved or been turned off.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="ghost" onClick={() => window.history.back()}>
            <ArrowLeft size={13} /> Go back
          </Button>
          <Link to={home}>
            <Button variant="primary">{projectId ? "Project overview" : "Dashboard"}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
