import { useEffect, useState } from "react";
import { useOutletContext, useParams, Link } from "react-router-dom";
import { ArrowLeft, Shield, RefreshCw, Users, Clock, ExternalLink } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CanisterID } from "@/components/CanisterID";
import type { ProjectContext } from "@/components/layout/AppShell";
import { listAuthCanisters, listUserProfiles, getAuthConfig, profileActivity, type UserProfile, type AuthCanisterConfig } from "@/lib/authProfiles";

const PAGE_SIZE = 20;

function UserRow({ user, selected, onClick }: { user: UserProfile; selected: boolean; onClick: () => void }) {
  const label = user.displayName ?? user.email ?? user.principal ?? `Profile #${user.id}`;
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-[#1e2d47] last:border-0 transition-colors ${
        selected ? "bg-[#00d4ff0d]" : "hover:bg-[#131929]"
      }`}
    >
      <div className="w-8 h-8 rounded-full bg-[#00d4ff11] border border-[#00d4ff33] flex items-center justify-center flex-shrink-0 text-xs font-semibold text-[#00d4ff] overflow-hidden">
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" /> : label.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[#e2e8f0] truncate">{label}</div>
        <div className="text-[11px] text-[#4a5568] truncate">{user.email ?? (user.principal ? `${user.principal.slice(0, 20)}…` : "no email on file")}</div>
      </div>
      <div className="flex gap-1 flex-shrink-0">
        {user.oauthLinks.map((l) => (
          <Badge key={l.provider} variant="cyan">{l.provider}</Badge>
        ))}
        {!user.principal && user.oauthLinks.length === 0 && <Badge variant="gray">unlinked</Badge>}
      </div>
    </button>
  );
}

/** The selected user's real profile fields plus a derived activity timeline
 * (see `lib/authProfiles.ts::profileActivity`'s own doc comment on why
 * it's derived, not a dedicated audit log the real canister doesn't have). */
function UserDetailPanel({ user }: { user: UserProfile }) {
  const events = profileActivity(user);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[#4a5568]">Profile ID</span>
            <span className="text-[#e2e8f0] font-mono">#{user.id}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#4a5568] flex-shrink-0">Principal</span>
            {user.principal ? <CanisterID id={user.principal} /> : <span className="text-[#4a5568]">not linked</span>}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#4a5568]">Email</span>
            <span className="text-[#e2e8f0] truncate">{user.email ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#4a5568]">Display name</span>
            <span className="text-[#e2e8f0] truncate">{user.displayName ?? "—"}</span>
          </div>
        </CardContent>
      </Card>

      {user.oauthLinks.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Linked Providers</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {user.oauthLinks.map((l) => (
              <div key={l.provider} className="flex items-center justify-between text-xs">
                <Badge variant="cyan">{l.provider}</Badge>
                <span className="text-[#4a5568] truncate">{l.email ?? l.subject}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-1.5"><Clock size={13} /> Activity</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {events.map((e, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00d4ff] flex-shrink-0 mt-1.5" />
              <div className="min-w-0">
                <div className="text-[#e2e8f0]">{e.label}</div>
                <div className="text-[#4a5568] font-mono">{new Date(e.at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/** "when user click on a Canister, it takes to the Auth Detail Page, user
 * management with user activity logs" (the user's own framing) - real
 * `list_profiles`/`get_config` calls direct to this project's own `auth`
 * canister (controller-only on the real canister, which the signed-in user
 * genuinely is - see `lib/authProfiles.ts`'s own doc comment). Activity is
 * a derived timeline from each profile's own real timestamps, not a
 * fabricated log the canister doesn't actually keep. */
export default function AuthDetailPage() {
  const { job, loadError } = useOutletContext<ProjectContext>();
  const { canisterId } = useParams<{ canisterId: string }>();

  const [config, setConfig] = useState<AuthCanisterConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canisterName = job ? listAuthCanisters(job).find((c) => c.id === canisterId)?.name ?? canisterId : canisterId;
  const network = job?.network ?? "local";

  const loadPage = (offset: number) => {
    if (!canisterId) return;
    setLoadingUsers(true);
    setUsersError(null);
    listUserProfiles(canisterId, network, offset, PAGE_SIZE)
      .then((page) => {
        setUsers((prev) => (offset === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((e) => setUsersError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingUsers(false));
  };

  useEffect(() => {
    if (!canisterId || !job) return;
    setUsers([]);
    setSelectedId(null);
    loadPage(0);
    getAuthConfig(canisterId, network)
      .then(setConfig)
      .catch((e) => setConfigError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canisterId, job]);

  if (loadError) {
    return <div className="p-6 text-sm text-[#ff5252]">Couldn't load this project: {loadError}</div>;
  }
  if (!job) {
    return <div className="p-6 text-sm text-[#4a5568]">Loading…</div>;
  }

  const selectedUser = users.find((u) => u.id === selectedId) ?? null;

  return (
    <div className="p-4 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <Link to={`/project/${job.id}/auth`} className="inline-flex items-center gap-1 text-xs text-[#4a5568] hover:text-[#e2e8f0] transition-colors mb-2">
            <ArrowLeft size={12} /> Back to Auth
          </Link>
          <h2 className="text-lg font-semibold text-[#e2e8f0] flex items-center gap-2">
            <Shield size={18} className="text-[#00d4ff]" /> {canisterName}
          </h2>
          <div className="flex items-center gap-2 mt-1">
            <CanisterID id={canisterId ?? ""} className="text-xs" />
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => loadPage(0)} disabled={loadingUsers}>
          <RefreshCw size={13} className={loadingUsers ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {configError && <p className="text-xs text-[#ff5252]">Couldn't load config: {configError}</p>}
      {config && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-[#4a5568]">Providers</span>
              {config.providers.length === 0 ? (
                <span className="text-[#4a5568]">none configured</span>
              ) : (
                config.providers.map((p) => <Badge key={p} variant="cyan">{p}</Badge>)
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[#4a5568]">Session TTL</span>
              <span className="text-[#e2e8f0] font-mono">{Math.round(config.sessionTtlSecs / 3600)}h</span>
            </div>
            {config.frontendRedirectUrl && (
              <a href={config.frontendRedirectUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#00d4ff] hover:underline">
                Redirect URL <ExternalLink size={10} />
              </a>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <h3 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider flex items-center gap-1.5">
            <Users size={12} /> Users {users.length > 0 && `(${users.length})`}
          </h3>
          <Card className="overflow-hidden">
            {usersError && <p className="text-sm text-[#ff5252] p-4">Couldn't load users: {usersError}</p>}
            {!usersError && users.length === 0 && !loadingUsers && <p className="text-sm text-[#4a5568] p-4">No users have signed in yet.</p>}
            {users.map((u) => (
              <UserRow key={u.id} user={u} selected={u.id === selectedId} onClick={() => setSelectedId(u.id === selectedId ? null : u.id)} />
            ))}
          </Card>
          {hasMore && users.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => loadPage(users.length)} disabled={loadingUsers}>
              {loadingUsers ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>

        <div>
          {selectedUser ? (
            <UserDetailPanel user={selectedUser} />
          ) : (
            <Card>
              <CardContent className="text-sm text-[#4a5568] text-center py-8">Select a user to see their profile and activity.</CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
