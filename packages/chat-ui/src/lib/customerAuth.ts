// Internet Identity sign-in for the customer-facing web channel. Separate
// from `auth.ts` on purpose: the customer page is a public page that may be
// iframed by anyone, so it must never run the dashboard delegation handshake
// (`parentDelegation.ts`) - it only ever uses its own II session.
//
// The customer's principal IS their conversation id on the backend: the
// canister keys the web session by caller, so there is no client-chosen id
// that could be guessed or replayed to read someone else's chat.

import { AuthClient } from "@icp-sdk/auth/client";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import { useEffect, useState } from "react";
import { network } from "./canisterId";

const MOCK = import.meta.env.VITE_MOCK === "1";
const MOCK_KEY = "mock-customer-signed-in";

const IDENTITY_PROVIDER = network() === "ic" ? "https://id.ai/authorize" : "http://id.ai.localhost:8000/authorize";
const MAX_TIME_TO_LIVE = BigInt(8) * BigInt(3_600_000_000_000);

let client: AuthClient | null = null;
const getClient = () => (client ??= new AuthClient({ identityProvider: IDENTITY_PROVIDER }));

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function mockSignedIn(): boolean {
  try {
    return sessionStorage.getItem(MOCK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Never throws; anonymous when not signed in (callers gate on that). */
export async function resolveCustomerIdentity(): Promise<Identity> {
  const c = getClient();
  return c.isAuthenticated() ? await c.getIdentity() : new AnonymousIdentity();
}

export function useCustomerAuth() {
  const [state, setState] = useState<{ status: "loading" | "anonymous" | "authenticated"; principal: string | null }>({
    status: "loading",
    principal: null,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      let next: typeof state;
      if (MOCK) {
        next = mockSignedIn()
          ? { status: "authenticated", principal: "k7x2p-4q5ab-cdefg-hijkl-mnopq-rstuv-wxyz2-34567-abcde-fgh12-cae" }
          : { status: "anonymous", principal: null };
      } else {
        const c = getClient();
        next = c.isAuthenticated()
          ? { status: "authenticated", principal: (await c.getIdentity()).getPrincipal().toText() }
          : { status: "anonymous", principal: null };
      }
      if (!cancelled) setState(next);
    };
    void refresh();
    listeners.add(refresh);
    return () => {
      cancelled = true;
      listeners.delete(refresh);
    };
  }, []);

  const signIn = async () => {
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 600));
      sessionStorage.setItem(MOCK_KEY, "1");
    } else {
      await getClient().signIn({ maxTimeToLive: MAX_TIME_TO_LIVE });
    }
    notify();
  };

  const signOut = async () => {
    if (MOCK) sessionStorage.removeItem(MOCK_KEY);
    else await getClient().signOut();
    notify();
  };

  return { ...state, signIn, signOut };
}
