// Real project data, read directly from the `backend` canister - no
// orchestrator HTTP call anywhere in this file. Replaces the old
// `listJobs`/`getJob` (`GET /jobs`, `GET /jobs/:id`, both removed - see
// the architecture plan this implements). Adapts bindgen's typed backend
// values (enums, optional fields, bigint timestamps) into the same plain-JS shape
// the dashboard already rendered from the orchestrator's old `Job` type,
// so `Dashboard.tsx`/`Overview.tsx`/etc. only need their data *source*
// swapped, not their whole rendering logic - `log`/`token_usage` are
// genuinely gone though (project-level state now, not per-tool-call detail
// - see `backend/src/lib.rs`'s own doc comment on why), not silently dropped.

import { Principal } from "@icp-sdk/core/principal";
import { getBackendActor, getModuleConfigActor } from "./actors";
import {
  CanisterKind as RawCanisterKind,
  ProjectState as RawProjectState,
  type Project as RawProject,
} from "../bindings/backend";

export type ProjectState = "running" | "awaiting_answer" | "succeeded" | "failed";
export type CanisterKind = "connector" | "agent" | "admin_agent" | "notification" | "auth" | "database" | "analytics" | "static" | "other";

/** A short, human label for each project-side building-block kind - shared
 * by `Overview.tsx`'s canister cards and `Wallet.tsx`'s per-service Usage
 * Breakdown (both group/label the same real `CanisterKind`, so one shared
 * map instead of two copies). */
export const CANISTER_KIND_LABELS: Record<CanisterKind, string> = {
  connector: "Connector",
  agent: "Agent",
  admin_agent: "Admin Agent",
  notification: "Notification",
  auth: "Auth",
  database: "Database",
  analytics: "Analytics",
  static: "Static",
  other: "Other",
};

export interface CanisterInfo {
  id: string;
  kind: CanisterKind;
  /** Stable `.wasm` package name, when this canister came from the
   * package registry. Null for imported/runtime/legacy canisters. */
  packageName: string | null;
}

export interface Project {
  id: string;
  request: string;
  network: string;
  owner: string;
  state: ProjectState;
  pending_question: string | null;
  project_name: string | null;
  canisters: Record<string, CanisterInfo>;
  llm_context: string | null;
  final_message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function nanosToIso(nanos: bigint): string {
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function adaptState(state: RawProjectState): ProjectState {
  if (state === RawProjectState.Running) return "running";
  if (state === RawProjectState.AwaitingAnswer) return "awaiting_answer";
  if (state === RawProjectState.Succeeded) return "succeeded";
  return "failed";
}

function adaptKind(kind: RawCanisterKind): CanisterKind {
  if (kind === RawCanisterKind.Connector) return "connector";
  if (kind === RawCanisterKind.Agent) return "agent";
  if (kind === RawCanisterKind.AdminAgent) return "admin_agent";
  if (kind === RawCanisterKind.Notification) return "notification";
  if (kind === RawCanisterKind.Auth) return "auth";
  if (kind === RawCanisterKind.Database) return "database";
  if (kind === RawCanisterKind.Analytics) return "analytics";
  if (kind === RawCanisterKind.Static) return "static";
  return "other";
}

/** Inverse of `adaptKind` - needed by `addProjectCanisters` below to build
 * a real candid argument from a plain-JS `CanisterKind`. */
function encodeKind(kind: CanisterKind): RawCanisterKind {
  if (kind === "connector") return RawCanisterKind.Connector;
  if (kind === "agent") return RawCanisterKind.Agent;
  if (kind === "admin_agent") return RawCanisterKind.AdminAgent;
  if (kind === "notification") return RawCanisterKind.Notification;
  if (kind === "auth") return RawCanisterKind.Auth;
  if (kind === "database") return RawCanisterKind.Database;
  if (kind === "analytics") return RawCanisterKind.Analytics;
  if (kind === "static") return RawCanisterKind.Static;
  return RawCanisterKind.Other;
}

function adaptProject(raw: RawProject): Project {
  return {
    id: raw.id,
    request: raw.request,
    network: raw.network,
    owner: raw.owner.toText(),
    state: adaptState(raw.state),
    pending_question: raw.pending_question ?? null,
    project_name: raw.project_name ?? null,
    canisters: Object.fromEntries(raw.canisters.map(([name, info]) => {
      const kind = adaptKind(info.kind);
      const legacyNotification = kind === "other" && name.toLowerCase() === "notification";
      return [name, {
        id: info.id.toText(),
        kind: legacyNotification ? "notification" : kind,
        packageName: info.package_name ?? null,
      }];
    })),
    llm_context: raw.llm_context ?? null,
    final_message: raw.final_message ?? null,
    error: raw.error ?? null,
    created_at: nanosToIso(raw.created_at),
    updated_at: nanosToIso(raw.updated_at),
  };
}

/** Every project the caller owns, newest first - direct replacement for
 * `GET /jobs`. */
export async function listMyProjects(): Promise<Project[]> {
  const actor = await getBackendActor();
  const raw = await actor.list_my_projects();
  return raw.map(adaptProject);
}

/** One project by id, or `null` if it doesn't exist (or isn't owned by the
 * caller - see `backend::get_project`'s own doc comment on why those two
 * cases are indistinguishable) - direct replacement for `GET /jobs/:id`. */
export async function getProject(id: string): Promise<Project | null> {
  const actor = await getBackendActor();
  const raw = await actor.get_project(id);
  return raw === null ? null : adaptProject(raw);
}

export interface ProjectNotificationPreferences {
  push_enabled: boolean;
}

/** Reads the authenticated owner's saved project-wide push preference. */
export async function getProjectNotificationPreferences(id: string): Promise<ProjectNotificationPreferences> {
  const actor = await getBackendActor();
  const result = await actor.get_project_notification_preferences(id);
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok;
}

/** Saves the authenticated owner's project-wide push preference. */
export async function setProjectNotificationPreferences(id: string, enabled: boolean): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.set_project_notification_preferences(id, enabled);
  if ("Err" in result) throw new Error(result.Err);
}

/** Creates a new project directly on `backend`, as the real signed-in user -
 * the caller becomes its owner (see `backend::create_project`'s own doc
 * comment). The orchestrator has no part in this at all any more (see the
 * `decouple-orchestrator-api` project notes) - creating a project is a pure
 * data write, independent of ever talking to the AI. Generates the id
 * client-side (`create_project` rejects a duplicate, so a fresh UUID is
 * always safe) and returns it. */
export async function createProject(request: string, network: string): Promise<string> {
  const id = crypto.randomUUID();
  const actor = await getBackendActor();
  const result = await actor.create_project(id, request, network);
  if ("Err" in result) throw new Error(result.Err);
  return id;
}

/** Merges newly deployed canister ids into a project's tracked set - call
 * directly after a real `install_code` call (see `lib/deploy.ts`) succeeds,
 * as the project's own owner. Mirrors `removeProjectCanister`'s shape. */
export async function addProjectCanisters(id: string, canisters: Array<[string, CanisterInfo]>): Promise<void> {
  const actor = await getBackendActor();
  const raw: Array<[string, { id: Principal; kind: RawCanisterKind; package_name?: string }]> = canisters.map(([name, info]) => [name, {
    id: Principal.fromText(info.id),
    kind: encodeKind(info.kind),
    ...(info.packageName ? { package_name: info.packageName } : {}),
  }]);
  const result = await actor.add_project_canisters(id, raw);
  if ("Err" in result) throw new Error(result.Err);
  await refreshProjectCanisterConfigs(id);
}

/** Broadcast the authoritative project canister list to every tracked
 * canister. Modules that implement the SDK dynamic-config surface refresh
 * package-derived defaults and preserve values users set in their settings. */
export async function refreshProjectCanisterConfigs(id: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  const context = {
    project_id: project.id,
    canisters: Object.values(project.canisters)
      .filter((canister): canister is CanisterInfo & { packageName: string } => Boolean(canister.packageName))
      .map((canister) => ({ canister_id: Principal.fromText(canister.id), package_name: canister.packageName })),
  };
  const calls = Object.values(project.canisters).map(async (canister) => {
    const module = await getModuleConfigActor(canister.id, project.network);
    const result = await module.update_project_context(context);
    if ("Err" in result) throw new Error(result.Err);
  });
  const results = await Promise.allSettled(calls);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.debug("Project context refresh skipped/failed for canister", Object.values(project.canisters)[index].id, result.reason);
    }
  });
}

/** Resolves a project dependency by the package registry's stable identity.
 * Package names and canister names are presentation details and must not be
 * used for wiring. */
export function findProjectCanisterByPackage(project: Project, packageName: string): CanisterInfo | null {
  return Object.values(project.canisters).find((canister) => canister.packageName === packageName) ?? null;
}

/** Renames a project - the Settings page's General tab. Owner-gated. */
export async function setProjectName(id: string, name: string): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.set_project_name(id, name);
  if ("Err" in result) throw new Error(result.Err);
}

/** Permanently deletes a project's own record - the Settings page's Danger
 * Zone. Owner-gated. See `backend::delete_project`'s own doc comment: this
 * never touches any real canister the project named, so the frontend (not
 * `backend`) is what requires `canisters` be empty first - see
 * `Settings.tsx::DangerZoneTab`. */
export async function deleteProject(id: string): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.delete_project(id);
  if ("Err" in result) throw new Error(result.Err);
}

/** Drops one canister from a project's tracked set - call only after the
 * real `delete_canister` management-canister call it names has actually
 * succeeded (see `lib/canisterOps.ts::deleteCanister`), so this never
 * un-tracks a canister that's still live. Owner-gated on `backend` itself
 * (see `backend::remove_project_canister`'s own doc comment) - the caller
 * doesn't need to be a controller of `backend`, just of the project. */
export async function removeProjectCanister(id: string, name: string): Promise<void> {
  const actor = await getBackendActor();
  const result = await actor.remove_project_canister(id, name);
  if ("Err" in result) throw new Error(result.Err);
  await refreshProjectCanisterConfigs(id);
}
