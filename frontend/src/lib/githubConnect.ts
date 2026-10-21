// The "Connect Git" flow - real GitHub OAuth-backed verification that a repo
// is actually controlled by whoever is registering it, replacing a plain
// `register_repo_publisher` call the dashboard used to make directly.
// `backend::register_repo_publisher` is now controller-only (it has no way
// to verify GitHub ownership itself - see its own doc comment), so the only
// path left is the orchestrator's `/github/connect/*` routes
// (`services/orchestrator/src/github.rs`): it opens a real GitHub OAuth
// consent screen in a popup, and only after GitHub's own API confirms the
// authorized account administers the repo does the orchestrator (a
// controller) call `register_repo_publisher` on this dashboard's behalf.

import { getBackendActor } from "./actors";
import { runtimeValue } from "./canisterEnv";
import type { Principal } from "@icp-sdk/core/principal";

const ORCHESTRATOR_URL = (runtimeValue("ORCHESTRATOR_URL") ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export interface GithubConnectResult {
  success: boolean;
  repoUrl: string;
  error: string | null;
}

async function readJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Orchestrator returned HTTP ${response.status}`);
  return value;
}

/** Opens a GitHub OAuth popup for `gitRepoUrl` and resolves once it reports
 * an outcome (or is closed without one). On success, the orchestrator has
 * already called `register_repo_publisher(gitRepoUrl, publisher)` as its own
 * controller identity by the time this resolves - there is nothing further
 * for the caller to do but reflect the result in the UI. */
export async function connectGithubRepo(publisher: Principal, gitRepoUrl: string): Promise<GithubConnectResult> {
  const actor = await getBackendActor();
  const tokenResult = await actor.issue_jwt();
  if ("Err" in tokenResult) throw new Error(tokenResult.Err);

  const startUrl = new URL(`${ORCHESTRATOR_URL}/github/connect/start`);
  startUrl.searchParams.set("repo_url", gitRepoUrl);
  startUrl.searchParams.set("publisher", publisher.toText());
  const body = await readJson(
    await fetch(startUrl.toString(), { headers: { Authorization: `Bearer ${tokenResult.Ok}` } })
  );
  const authorizeUrl: string = body.authorize_url;

  const popup = window.open(authorizeUrl, "github-connect", "width=600,height=750");
  if (!popup) throw new Error("Popup was blocked - allow popups for this site and try again.");

  const expectedOrigin = new URL(ORCHESTRATOR_URL).origin;

  return new Promise<GithubConnectResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(pollClosed);
    };
    const onMessage = (event: MessageEvent) => {
      // The callback page is served from the orchestrator's own origin, not
      // this dashboard's - only trust a result that actually came from it.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { type?: string; success?: boolean; repo_url?: string; error?: string | null } | null;
      if (!data || data.type !== "canister-hub-github-connect") return;
      settled = true;
      cleanup();
      resolve({ success: !!data.success, repoUrl: data.repo_url ?? gitRepoUrl, error: data.error ?? null });
    };
    window.addEventListener("message", onMessage);
    const pollClosed = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        if (!settled) reject(new Error("Connection window was closed before finishing."));
      }
    }, 500);
  });
}
