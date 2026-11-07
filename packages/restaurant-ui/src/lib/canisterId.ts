// Resolves which canister this embedded UI talks to, and which IC network
// it's on. Unlike the main dashboard (`frontend/`), this app has no
// "project"/multi-canister concept at all - it's always served BY, and
// always talks to, exactly one `restaurant` canister: itself.
//
// The canister id comes from the real `ic_env` cookie convention
// `@icp-sdk/core/agent/canister-env` defines - the same mechanism
// `frontend/`'s own `lib/canisterEnv.ts` reads, not a one-off templating
// scheme. `restaurant` itself stamps this cookie on every response (see
// `packages/restaurant/src/assets.rs::ic_env_cookie`), keyed
// `PUBLIC_CANISTER_ID:backend` by that same convention - here it's
// `restaurant`'s own id. The Vite dev server has no running `restaurant` to set
// that cookie, so `VITE_RESTAURANT_CANISTER_ID`/`VITE_IC_NETWORK` (a
// `.env.local` you provide - see README.md) stand in for local
// development instead.

import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";

type RuntimeCanisterEnv = {
  readonly ["PUBLIC_CANISTER_ID:backend"]?: string;
  readonly ["storage_canister_id"]?: string;
};

function canisterEnv() {
  return safeGetCanisterEnv<RuntimeCanisterEnv>();
}

let cachedCanisterId: string | null = null;

/** The HTTP gateway already identifies the serving canister in either the
 * subdomain or `canisterId` query parameter. This is a reliable fallback
 * when a browser blocks the `ic_env` Set-Cookie header inside an embedded,
 * cross-origin iframe. Principal parsing prevents an arbitrary hostname or
 * query value from being accepted as a canister id. */
function canisterIdFromLocation(): string | undefined {
  const url = new URL(window.location.href);
  const queryId = url.searchParams.get("canisterId");
  const hostId = url.hostname.split(".")[0];
  for (const candidate of [queryId, hostId]) {
    if (!candidate) continue;
    try {
      return Principal.fromText(candidate).toText();
    } catch {
      // Try the next gateway representation.
    }
  }
  return undefined;
}

/** Throws if neither the `ic_env` cookie nor the dev-server env named a
 * real canister id - there is nothing sensible to fall back to (unlike a
 * multi-canister dashboard, this app can't just show an empty state for
 * "no canister selected yet"; it IS the one canister). */
export function restaurantCanisterId(): string {
  if (cachedCanisterId) return cachedCanisterId;
  const id = canisterEnv()?.["PUBLIC_CANISTER_ID:backend"] || canisterIdFromLocation() || import.meta.env.VITE_RESTAURANT_CANISTER_ID;
  if (!id) {
    throw new Error(
      "No restaurant canister id available - this page wasn't served by restaurant (no ic_env cookie) " +
      "and VITE_RESTAURANT_CANISTER_ID isn't set for local dev (see README.md)."
    );
  }
  cachedCanisterId = id;
  return id;
}

export function storageCanisterIdFromEnv(): string | null {
  const candidate = canisterEnv()?.["storage_canister_id"];
  if (!candidate) return null;
  try { return Principal.fromText(candidate).toText(); }
  catch { return null; }
}

/** `"ic"` or `"local"` - `VITE_IC_NETWORK` wins for local dev; otherwise
 * inferred from the real hostname this page is actually being served
 * from, same convention as `frontend/`'s own `canisterEnv.ts::
 * runtimeNetwork` (gateway-domain check), simplified to the local-replica
 * case this app's dev/preview setup actually hits. */
export function network(): string {
  if (import.meta.env.VITE_IC_NETWORK) return import.meta.env.VITE_IC_NETWORK;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") ? "local" : "ic";
}

