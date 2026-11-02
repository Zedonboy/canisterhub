// Resolves which `order_inventory` canister this UI talks to and which IC network it
// is on. Same resolution order as `table-browser/src/lib/canisterId.ts`:
// the `ic_env` cookie the serving canister stamps, then the gateway's
// subdomain / `canisterId` query parameter, then the dev-only env var.

import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";

type RuntimeCanisterEnv = {
  readonly ["PUBLIC_CANISTER_ID:backend"]?: string;
  readonly storefront_business_name?: string;
  readonly storefront_logo_url?: string;
};

let cachedCanisterId: string | null = null;

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

export function inventoryCanisterId(): string {
  if (cachedCanisterId) return cachedCanisterId;
  const id =
    safeGetCanisterEnv<RuntimeCanisterEnv>()?.["PUBLIC_CANISTER_ID:backend"] ||
    canisterIdFromLocation() ||
    import.meta.env.VITE_INVENTORY_CANISTER_ID;
  if (!id) {
    throw new Error(
      "No agent canister id available - this page wasn't served by the order_inventory canister " +
        "and VITE_INVENTORY_CANISTER_ID isn't set for local dev (see README.md).",
    );
  }
  cachedCanisterId = id;
  return id;
}

export function network(): string {
  if (import.meta.env.VITE_IC_NETWORK) return import.meta.env.VITE_IC_NETWORK;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") ? "local" : "ic";
}

export interface StorefrontBranding {
  businessName: string | null;
  logoUrl: string | null;
}

function optionalCookieValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Branding stamped into the certified `ic_env` cookie by order_inventory. */
export function storefrontBranding(): StorefrontBranding {
  const env = safeGetCanisterEnv<RuntimeCanisterEnv>();
  return {
    businessName: optionalCookieValue(env?.storefront_business_name),
    logoUrl: optionalCookieValue(env?.storefront_logo_url),
  };
}
