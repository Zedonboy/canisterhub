// Real Internet Identity login for the dashboard, via `@icp-sdk/auth`'s
// `AuthClient` - following the `internet-identity` skill
// (https://skills.internetcomputer.org/.well-known/skills/internet-identity/SKILL.md),
// authoritative here per this project's own AGENTS.md. This is what makes
// `lib/agent.ts`'s direct canister/backend calls use a real, non-anonymous
// identity once someone signs in - see `resolveIdentity`.

import { AuthClient, SessionNotHeldError } from "@icp-sdk/auth/client";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import { DelegationIdentity } from "@icp-sdk/core/identity";
import { useEffect, useState } from "react";
import { canisterEnv, runtimeNetwork } from "./canisterEnv";

/** Internet Identity endpoints are intentionally fixed rather than
 * configurable: the managed local network serves II at id.ai.localhost,
 * while production uses the hosted id.ai service. */
const INTERNET_IDENTITY_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";
const LOCAL_ROOT_KEY_STORAGE_KEY = "canister-hub:local-root-key";

/** 8 hours - a normal app's session length per the skill's own guidance
 * (30 days is the protocol max, but longer is a real usability/security
 * tradeoff this dashboard doesn't need to make). */
const MAX_TIME_TO_LIVE = BigInt(8) * BigInt(3_600_000_000_000);

let authClientPromise: Promise<AuthClient> | null = null;

function rootKeyFingerprint(rootKey: Uint8Array): string {
  return Array.from(rootKey, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAuthClient(): Promise<AuthClient> {
  const isLocal = runtimeNetwork() !== "ic";
  const rootKey = isLocal ? canisterEnv()?.IC_ROOT_KEY : undefined;
  const client = new AuthClient({
    ...(isLocal
      ? {
          identityProvider: {
            authorizeUrl: "http://id.ai.localhost:8000/authorize",
            canisterId: INTERNET_IDENTITY_CANISTER_ID,
          },
          // Local II mints its delegations through an agent too. That agent
          // must verify certificates with the local replica's root key, not
          // the SDK's built-in mainnet key.
          agentOptions: { rootKey },
        }
      : {
          identityProvider: {
            authorizeUrl: "https://id.ai/authorize",
            canisterId: INTERNET_IDENTITY_CANISTER_ID,
          },
        }),
  });

  if (rootKey && typeof globalThis.localStorage !== "undefined") {
    const currentRootKey = rootKeyFingerprint(rootKey);
    const previousRootKey = globalThis.localStorage.getItem(LOCAL_ROOT_KEY_STORAGE_KEY);

    // A managed local replica gets a new root key when its state is reset.
    // Delegations stored by II before that reset remain time-valid, but their
    // canister signatures can never verify on the new replica. Clear that
    // stale session before any ledger request can reuse it. `null` also
    // handles sessions created by the older auth SDK before this guard existed.
    if (client.isAuthenticated() && previousRootKey !== currentRootKey) {
      // Auth 10 clears local credentials even when the remote revoke fails.
      // A stale delegation cannot authenticate that revoke on the new replica,
      // so deliberately ignore that expected remote error here.
      await client.signOut().catch(() => undefined);
    }
    globalThis.localStorage.setItem(LOCAL_ROOT_KEY_STORAGE_KEY, currentRootKey);
  }

  return client;
}

function getAuthClient(): Promise<AuthClient> {
  authClientPromise ??= createAuthClient();
  return authClientPromise;
}

async function heldIdentity(client: AuthClient): Promise<Identity | null> {
  if (!client.isAuthenticated()) return null;
  try {
    return await client.getIdentity();
  } catch (error) {
    if (!(error instanceof SessionNotHeldError)) throw error;
    // Auth state can outlive the origin's actual credential (for example
    // after migrating storage formats). Do not leave protected routes stuck
    // in their loading state or issue requests with unusable credentials.
    await client.signOut().catch(() => undefined);
    return null;
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

/** Subscribes to login/logout changes - `useAuth`'s own re-resolve trigger
 * after `signIn`/`signOut`. Returns an unsubscribe function. */
function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The real authenticated identity, or a fresh `AnonymousIdentity` if no
 * one is signed in - never throws, mirrors `AuthClient`'s own
 * `isAuthenticated() ? await getIdentity() : ...` convention (see the
 * skill's session-persistence example), so every direct canister call in
 * `lib/agent.ts` can call this unconditionally without checking auth state
 * itself first. */
export async function resolveIdentity(): Promise<Identity> {
  const client = await getAuthClient();
  return (await heldIdentity(client)) ?? new AnonymousIdentity();
}

/** The real `DelegationIdentity` behind the signed-in session, or `null`
 * if no one is signed in - distinct from `resolveIdentity` (which falls
 * back to a fresh `AnonymousIdentity`, never `null`) because forwarding a
 * sub-delegation into an embedded module's iframe (see
 * `lib/moduleDelegation.ts`) needs the actual sign-capable session
 * identity to delegate from, not just "some `Identity`" - there's nothing
 * to forward when no one is signed in. `AuthClient`'s default key storage
 * is a non-extractable WebCrypto key, but that only blocks reading the raw
 * private key out, not signing with it - `DelegationIdentity.sign` (and
 * so `DelegationChain.create`, which signs through it) works the same
 * either way. */
export async function resolveDelegationIdentity(): Promise<DelegationIdentity | null> {
  const client = await getAuthClient();
  const identity = await heldIdentity(client);
  return identity instanceof DelegationIdentity ? identity : null;
}

export type AuthStatus = "loading" | "anonymous" | "authenticated";

export interface AuthState {
  status: AuthStatus;
  /** The real principal, once resolved - `null` while `status` is
   * `"loading"` or `"anonymous"`. */
  principal: string | null;
}

async function computeState(): Promise<AuthState> {
  const client = await getAuthClient();
  const identity = await heldIdentity(client);
  if (identity) {
    return { status: "authenticated", principal: identity.getPrincipal().toText() };
  }
  return { status: "anonymous", principal: null };
}

/** Reactive auth state for any component - resolves the real (possibly
 * restored) session on mount, and again after every `signIn`/`signOut`
 * anywhere in the app (see `subscribeAuth`/`notify` above), without every
 * caller needing its own polling or prop-drilling. */
export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "loading", principal: null });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      computeState().then((s) => {
        if (!cancelled) setState(s);
      });
    };
    refresh();
    const unsubscribe = subscribeAuth(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signIn = async () => {
    const client = await getAuthClient();
    // Real failures (the user closes the II popup, a rejected delegation,
    // ...) throw here - the skill's own "must await and catch" warning:
    // left to the caller to catch and surface, not swallowed here.
    await client.signIn({ maxTimeToLive: MAX_TIME_TO_LIVE });
    notify();
  };

  const signOut = async () => {
    const client = await getAuthClient();
    await client.signOut();
    notify();
  };

  return { ...state, signIn, signOut };
}
