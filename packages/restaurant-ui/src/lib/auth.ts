// Identity resolution for this app, in priority order:
//
//   1. Embedded-dashboard delegation (see `parentDelegation.ts`'s own doc
//      comment) - when this app is iframed into the dashboard, it acts as
//      the real signed-in dashboard user, scoped to just this one
//      canister, with no separate login step at all.
//   2. Standalone Internet Identity login, via `@icp-sdk/auth`'s
//      `AuthClient` - ported from `frontend/src/lib/auth.ts` (see that
//      file for the full rationale; same pattern, just resolving network
//      from `canisterId.ts` instead of a dashboard-wide runtime-env
//      cookie, since this app has no such thing). This is the only path
//      when not embedded at all (`parentDelegation.ts::isEmbedded()` is
//      `false`) - the "Sign in" button `AuthControl` (`App.tsx`) shows.
//   3. Anonymous, if neither of the above applies. Restaurant manager methods
//      are controller-only; public food ordering uses the anonymous identity.
//      anything here - `App.tsx` shows a sign-in prompt instead.

import { AuthClient } from "@icp-sdk/auth/client";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import { useEffect, useState } from "react";
import { network } from "./canisterId";
import { getDelegatedIdentity, isEmbedded, onDelegationChange, sessionEnded } from "./parentDelegation";

/** Internet Identity endpoints are fixed, same as `frontend/src/lib/auth.ts`:
 * the managed local network serves II at id.ai.localhost, production uses
 * the hosted id.ai service. */
const INTERNET_IDENTITY_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";

/** 8 hours - see `frontend/src/lib/auth.ts`'s own doc comment. */
const MAX_TIME_TO_LIVE = BigInt(8) * BigInt(3_600_000_000_000);

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  authClientPromise ??= Promise.resolve(
    new AuthClient({
      identityProvider:
        network() === "ic"
          ? { authorizeUrl: "https://id.ai/authorize", canisterId: INTERNET_IDENTITY_CANISTER_ID }
          : { authorizeUrl: "http://id.ai.localhost:8000/authorize", canisterId: INTERNET_IDENTITY_CANISTER_ID },
    })
  );
  return authClientPromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

// a renewed or lost dashboard delegation changes who we are (or whether we are anyone)
onDelegationChange(notify);

function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The real identity to call canisters with, in the priority order this
 * file's own doc comment lays out - never throws, so every direct
 * canister call in `lib/agent.ts` can call this unconditionally. */
export async function resolveIdentity(): Promise<Identity> {
  if (isEmbedded()) {
    const delegated = await getDelegatedIdentity();
    if (delegated) return delegated;
  }
  const client = await getAuthClient();
  if (client.isAuthenticated()) {
    return client.getIdentity();
  }
  return new AnonymousIdentity();
}

export type AuthStatus = "loading" | "anonymous" | "authenticated";

export interface AuthState {
  status: AuthStatus;
  principal: string | null;
  /** `true` when `principal` came from the embedded-dashboard delegation
   * (see `parentDelegation.ts`), not a standalone Internet Identity
   * session - there's nothing to "sign out" of in that case (the session
   * belongs to the parent dashboard, not this frame), so `AuthControl`
   * (`App.tsx`) hides that button whenever this is `true`. */
  delegated: boolean;
  /** `true` when this page was acting as the dashboard user and that
   * delegation has ended - the user must sign in again on the dashboard. */
  sessionEnded: boolean;
}

async function computeState(): Promise<AuthState> {
  if (isEmbedded()) {
    const delegated = await getDelegatedIdentity();
    if (delegated) {
      return { status: "authenticated", principal: delegated.getPrincipal().toText(), delegated: true, sessionEnded: false };
    }
  }
  const client = await getAuthClient();
  if (client.isAuthenticated()) {
    const identity = await client.getIdentity();
    return { status: "authenticated", principal: identity.getPrincipal().toText(), delegated: false, sessionEnded: false };
  }
  return { status: "anonymous", principal: null, delegated: false, sessionEnded: isEmbedded() && sessionEnded() };
}

/** Reactive auth state for any component - resolves the real (possibly
 * restored) session on mount, and again after every `signIn`/`signOut`. */
export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "loading", principal: null, delegated: false, sessionEnded: false });

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
