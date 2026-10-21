// Hand-written mirror of the real `auth` building block's user-management
// surface (see `packages/auth/auth.did`) - `list_profiles`/`get_profile`/
// `get_config` are all controller-only on the real canister
// (`packages/auth/src/lib.rs::require_controller`), which the real
// signed-in user genuinely is for every auth canister this dashboard
// deployed for them (`process::add_controller`/`lib/deploy.ts`'s own
// `update_settings` call - see `per-user-canister-ownership` project
// notes), so these calls work for real, not just in principle.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export interface OAuthLink {
  provider: string;
  subject: string;
  email: [] | [string];
  linked_at: bigint;
}

export interface Profile {
  id: bigint;
  updated_at: bigint;
  principal: [] | [Principal];
  avatar_url: [] | [string];
  oauth_links: OAuthLink[];
  created_at: bigint;
  email: [] | [string];
  display_name: [] | [string];
}

export interface ProfileClaims {
  profile_id: bigint;
  principal: [] | [Principal];
  display_name: [] | [string];
  email: [] | [string];
  avatar_url: [] | [string];
}

/** Deliberately omits `client_secret` from what this frontend ever reads
 * off `OAuthProviderConfig` - the real candid type has it (controller-only
 * on the canister side), but nothing here should ever put a real OAuth
 * client secret on screen. */
export interface OAuthProviderConfigPublic {
  userinfo_url: string;
  authorize_url: string;
  redirect_uri: string;
  scope: string;
  token_url: string;
  client_id: string;
}

export interface Config {
  trusted_canisters: Principal[];
  frontend_redirect_url: [] | [string];
  providers: Array<[string, OAuthProviderConfigPublic]>;
  session_ttl_secs: bigint;
}

export interface AuthService {
  list_profiles: (offset: bigint, limit: bigint) => Promise<{ Ok: Profile[] } | { Err: string }>;
  get_profile: (id: bigint) => Promise<{ Ok: [] | [Profile] } | { Err: string }>;
  get_auth_config: () => Promise<{ Ok: Config } | { Err: string }>;
  resolve_principal: (principal: Principal) => Promise<{ Ok: [] | [ProfileClaims] } | { Err: string }>;
  resolve_session: (sessionToken: string) => Promise<[] | [ProfileClaims]>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const OAuthLink = IDL.Record({ provider: IDL.Text, subject: IDL.Text, email: IDL.Opt(IDL.Text), linked_at: IDL.Nat64 });
  const Profile = IDL.Record({
    id: IDL.Nat64,
    updated_at: IDL.Nat64,
    principal: IDL.Opt(IDL.Principal),
    avatar_url: IDL.Opt(IDL.Text),
    oauth_links: IDL.Vec(OAuthLink),
    created_at: IDL.Nat64,
    email: IDL.Opt(IDL.Text),
    display_name: IDL.Opt(IDL.Text),
  });
  const ProfileClaims = IDL.Record({
    principal: IDL.Opt(IDL.Principal),
    avatar_url: IDL.Opt(IDL.Text),
    email: IDL.Opt(IDL.Text),
    display_name: IDL.Opt(IDL.Text),
    profile_id: IDL.Nat64,
  });
  // The real candid record also has `client_secret: text` - deliberately
  // left out of this decode shape (see `OAuthProviderConfigPublic`'s own
  // doc comment). `@icp-sdk/core`'s candid decoder only reads the fields a
  // `IDL.Record` declares, so omitting it here means the raw secret bytes
  // are never even parsed into a JS value, not just hidden from render.
  const OAuthProviderConfig = IDL.Record({
    userinfo_url: IDL.Text,
    authorize_url: IDL.Text,
    redirect_uri: IDL.Text,
    scope: IDL.Text,
    token_url: IDL.Text,
    client_id: IDL.Text,
  });
  const Config = IDL.Record({
    trusted_canisters: IDL.Vec(IDL.Principal),
    frontend_redirect_url: IDL.Opt(IDL.Text),
    providers: IDL.Vec(IDL.Tuple(IDL.Text, OAuthProviderConfig)),
    session_ttl_secs: IDL.Nat64,
  });
  const ProfileResult = IDL.Variant({ Ok: IDL.Opt(Profile), Err: IDL.Text });
  const ProfilesResult = IDL.Variant({ Ok: IDL.Vec(Profile), Err: IDL.Text });
  const ConfigResult = IDL.Variant({ Ok: Config, Err: IDL.Text });
  const ClaimsResult = IDL.Variant({ Ok: IDL.Opt(ProfileClaims), Err: IDL.Text });
  return IDL.Service({
    list_profiles: IDL.Func([IDL.Nat64, IDL.Nat64], [ProfilesResult], ["query"]),
    get_profile: IDL.Func([IDL.Nat64], [ProfileResult], ["query"]),
    get_auth_config: IDL.Func([], [ConfigResult], ["query"]),
    resolve_principal: IDL.Func([IDL.Principal], [ClaimsResult], ["query"]),
    resolve_session: IDL.Func([IDL.Text], [IDL.Opt(ProfileClaims)], ["query"]),
  });
};
