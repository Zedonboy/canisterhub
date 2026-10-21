// Real user-management data for one project's `auth` building block
// canister - direct canister calls, no orchestrator HTTP call anywhere in
// this file. Named distinctly from `lib/auth.ts` (this dashboard's own
// Internet Identity session) to avoid confusion: this file is about
// *other people's* profiles on a project's own `auth` canister, a
// completely different concern.
//
// `list_profiles`/`get_config` are controller-only on the real canister
// (`packages/auth/src/lib.rs::require_controller`) - see `candid/auth.ts`'s
// own doc comment on why that's real, working access for the actual
// signed-in user, not a wall this frontend has to work around.

import { getAuthActor } from "./actors";
import type { Project, CanisterInfo } from "./backend";
import type { Profile as RawProfile } from "./candid/auth";

export interface AuthCanister {
  name: string;
  id: string;
}

export interface OAuthLinkSummary {
  provider: string;
  subject: string;
  email: string | null;
  linkedAt: string;
}

export interface UserProfile {
  id: string;
  principal: string | null;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  oauthLinks: OAuthLinkSummary[];
}

export interface AuthCanisterConfig {
  frontendRedirectUrl: string | null;
  sessionTtlSecs: number;
  trustedCanisters: string[];
  /** Provider names only - never `client_secret` (see `candid/auth.ts`'s
   * own doc comment: this frontend never even decodes that field). */
  providers: string[];
}

/** A single real event in a user's own history - "user activity logs" (the
 * user's own framing), built entirely from `Profile`'s own real timestamped
 * fields (`created_at`/`updated_at`/each `oauth_links[].linked_at`) since
 * the real `auth` canister has no dedicated audit-log feature of its own
 * (nothing like `admin_agent`'s `ActionLogEntry`) - a derived timeline of
 * genuine data, not a fabricated log. */
export interface ActivityEvent {
  at: string;
  label: string;
}

function optToNullable<T>(opt: [] | [T]): T | null {
  return opt.length === 0 ? null : opt[0];
}

function nanosToIso(nanos: bigint): string {
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function adaptProfile(raw: RawProfile): UserProfile {
  return {
    id: raw.id.toString(),
    principal: optToNullable(raw.principal)?.toText() ?? null,
    displayName: optToNullable(raw.display_name),
    email: optToNullable(raw.email),
    avatarUrl: optToNullable(raw.avatar_url),
    createdAt: nanosToIso(raw.created_at),
    updatedAt: nanosToIso(raw.updated_at),
    oauthLinks: raw.oauth_links.map((l) => ({
      provider: l.provider,
      subject: l.subject,
      email: optToNullable(l.email),
      linkedAt: nanosToIso(l.linked_at),
    })),
  };
}

/** Every `Auth`-kind canister on this project - a pure client-side filter
 * of `Project.canisters` (already fetched from `backend`), no canister
 * call needed - same convention as `lib/database.ts::listDatabaseCanisters`. */
export function listAuthCanisters(project: Project): AuthCanister[] {
  return Object.entries(project.canisters)
    .filter(([, info]: [string, CanisterInfo]) => info.kind === "auth")
    .map(([name, info]) => ({ name, id: info.id }));
}

/** Newest-first, paginated - direct `list_profiles` call. */
export async function listUserProfiles(canisterId: string, network: string, offset: number, limit: number): Promise<UserProfile[]> {
  const actor = await getAuthActor(canisterId, network);
  const result = await actor.list_profiles(BigInt(offset), BigInt(limit));
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok.map(adaptProfile);
}

export async function getAuthConfig(canisterId: string, network: string): Promise<AuthCanisterConfig> {
  const actor = await getAuthActor(canisterId, network);
  const result = await actor.get_auth_config();
  if ("Err" in result) throw new Error(result.Err);
  return {
    frontendRedirectUrl: optToNullable(result.Ok.frontend_redirect_url),
    sessionTtlSecs: Number(result.Ok.session_ttl_secs),
    trustedCanisters: result.Ok.trusted_canisters.map((principal) => principal.toText()),
    providers: result.Ok.providers.map(([name]) => name),
  };
}

/** Builds one user's real activity timeline - see `ActivityEvent`'s own
 * doc comment on why this is derived, not a dedicated log. */
export function profileActivity(profile: UserProfile): ActivityEvent[] {
  const events: ActivityEvent[] = [{ at: profile.createdAt, label: "Profile created" }];
  for (const link of profile.oauthLinks) {
    events.push({ at: link.linkedAt, label: `Linked ${link.provider}${link.email ? ` (${link.email})` : ""}` });
  }
  if (profile.updatedAt !== profile.createdAt) {
    events.push({ at: profile.updatedAt, label: "Profile last updated" });
  }
  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
