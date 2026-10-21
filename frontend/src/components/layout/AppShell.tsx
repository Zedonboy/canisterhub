import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { CommandPalette } from "@/components/CommandPalette";
import { ToastProvider } from "@/components/Toast";
import { getProject, type Project } from "@/lib/backend";

/** What every child route under `/project/:id/*` reads via `useOutletContext`
 * - fetched here, directly from `backend` (see `lib/backend.ts` - no
 * orchestrator HTTP call) rather than each page re-fetching or falling
 * back to mock data of its own. `refetch` re-reads this same project from
 * `backend` - call it after a mutation a child page made that changes what
 * `backend` holds (e.g. `Database.tsx`'s "Deploy Database", which pushes a
 * new canister into the project's `canisters` map server-side - see
 * `orchestrator::routes::database::deploy_database`), so the whole shell
 * (this page, the sidebar, the header) reflects it without a full reload. */
export interface ProjectContext {
  job: Project | null;
  loadError: string | null;
  refetch: () => void;
}

export function AppShell() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    getProject(id)
      .then((project) => {
        if (project === null) {
          setLoadError("no such project");
          return;
        }
        setJob(project);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    setJob(null);
    setLoadError(null);
    load();
  }, [load]);

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        projectId={id ?? ""}
        job={job}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header job={job} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-[#0a0e1a]">
          <Outlet context={{ job, loadError, refetch: load } satisfies ProjectContext} />
        </main>
      </div>
      <CommandPalette projectId={id ?? ""} />
      <ToastProvider />
    </div>
  );
}
