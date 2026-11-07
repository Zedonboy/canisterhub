// Identity resolution for this app, in priority order:
//
//   1. Embedded-dashboard delegation (see `parentDelegation.ts`) - when
//      this app is iframed into the dashboard, it acts as the real
//      signed-in dashboard user, scoped to just this one canister, with no
//      separate login step at all.
//   2. Standalone Internet Identity login, via `@icp-sdk/auth`'s
//      `AuthClient` - same pattern as `table-browser`/`chat-ui`. This is
//      the only path when not embedded at all.
//
// Everything here is controller-gated on the canister side
// (`list_transactions`, `set_config`), so an anonymous identity is only a
// transient state before sign-in - unlike the public storefront pages,
// this internal UI has nothing useful to show anonymously.

import { AuthClient } from "@icp-sdk/auth/client";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import { useEffect, useState } from "react";
import { network } from "./canisterId";
import { getDelegatedIdentity, isEmbedded } from "./parentDelegation";

const IDENTITY_PROVIDER = network() === "ic"
  ? "https://id.ai/authorize"
  : "http://id.ai.localhost:8000/authorize";

/** 8 hours - see `frontend/src/lib/auth.ts`'s own doc comment. */
const MAX_TIME_TO_LIVE = BigInt(8) * BigInt(3_600_000_000_000);

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  authClientPromise ??= Promise.resolve(new AuthClient({ identityProvider: IDENTITY_PROVIDER }));
  return authClientPromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

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
   * belongs to the parent dashboard, not this frame), so the header hides
   * that button whenever this is `true`. */
  delegated: boolean;
}

async function computeState(): Promise<AuthState> {
  if (isEmbedded()) {
    const delegated = await getDelegatedIdentity();
    if (delegated) {
      return { status: "authenticated", principal: delegated.getPrincipal().toText(), delegated: true };
    }
  }
  const client = await getAuthClient();
  if (client.isAuthenticated()) {
    const identity = await client.getIdentity();
    return { status: "authenticated", principal: identity.getPrincipal().toText(), delegated: false };
  }
  return { status: "anonymous", principal: null, delegated: false };
}

/** Reactive auth state for any component - resolves the real (possibly
 * restored) session on mount, and again after every `signIn`/`signOut`. */
export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "loading", principal: null, delegated: false });

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
