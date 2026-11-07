// Resolves which payment canister this UI talks to, and which IC network
// it's on. This app has no "project"/multi-canister concept at all - it is
// always served BY, and always talks to, exactly one payment module
// canister (e.g. `kora-payment`): itself.
//
// The canister id comes from the real `ic_env` cookie convention
// `@icp-sdk/core/agent/canister-env` defines - the same mechanism
// `frontend/`'s own `lib/canisterEnv.ts` reads. The embedding canister
// stamps this cookie on every certified asset response (see
// `packages/kora-payment/src/assets.rs::ic_env_cookie`), keyed
// `PUBLIC_CANISTER_ID:backend` by that same convention. The Vite dev
// server has no running canister to set that cookie, so
// `VITE_PAYMENT_CANISTER_ID`/`VITE_IC_NETWORK` (a `.env.local` you provide
// - see README.md) stand in for local development instead.

import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";

type RuntimeCanisterEnv = {
  readonly ["PUBLIC_CANISTER_ID:backend"]?: string;
};

let cachedCanisterId: string | null = null;
let cachedNetwork: string | null = null;

/** The HTTP gateway already identifies the serving canister in either the
 * subdomain or `canisterId` query parameter. This is a reliable fallback
 * when a browser blocks the `ic_env` Set-Cookie header inside an embedded,
 * cross-origin iframe. Principal parsing prevents an arbitrary hostname or
 * query value from being accepted as a canister id. */
function canisterIdFromLocation(): string | undefined {
  const url = new URL(window.location.href);
  const candidates = [url.searchParams.get("canisterId"), url.hostname.split(".")[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return Principal.fromText(candidate).toText();
    } catch {
      // Not a principal - try the next representation.
    }
  }
  return undefined;
}

export function paymentCanisterId(): string {
  if (cachedCanisterId) return cachedCanisterId;
  const id =
    safeGetCanisterEnv<RuntimeCanisterEnv>()?.["PUBLIC_CANISTER_ID:backend"] ||
    canisterIdFromLocation() ||
    (import.meta.env.VITE_PAYMENT_CANISTER_ID ?? undefined);
  if (!id) {
    throw new Error(
      "No payment canister id available - this page wasn't served by a payment canister " +
        "and VITE_PAYMENT_CANISTER_ID isn't set for local dev (see README.md).",
    );
  }
  cachedCanisterId = id;
  return id;
}

/** `"local"` or `"ic"` - from the page origin (`.icp0.io` is mainnet;
 * everything else, including the local gateway, is local). */
export function network(): string {
  if (cachedNetwork) return cachedNetwork;
  const host = window.location.hostname;
  const fromEnv = (import.meta.env.VITE_IC_NETWORK ?? undefined) as string | undefined;
  cachedNetwork =
    host.endsWith(".icp0.io") || host === "icp0.io" ? "ic" : (fromEnv ?? "local");
  return cachedNetwork;
}
