// Which asset-storage canister item images go to. Two sources, in order:
//
//   1. The runtime canister environment (`canisterId.ts::storageCanisterIdFromEnv`):
//      `storage_canister_id` in the `ic_env` cookie. Quick, but browsers drop
//      that cookie when this page is embedded cross-site in the dashboard.
//   2. `order_inventory`'s own `storage_canister` setting (`get_config`),
//      which the dashboard's canister Settings page edits. A plain public
//      query, so it needs no identity and works in the iframe.
//
// `null` means "none configured" - the UI then hides image upload.

import { Principal } from "@icp-sdk/core/principal";
import { useEffect, useState } from "react";
import { getAnonymousInventoryActor } from "./actor";
import { storageCanisterIdFromEnv } from "./canisterId";

const CONFIG_KEY = "storage_canister";

let cached: Promise<string | null> | null = null;

export function resolveStorageCanisterId(): Promise<string | null> {
  cached ??= (async () => {
    const fromEnv = storageCanisterIdFromEnv();
    if (fromEnv) return fromEnv;
    try {
      const entries = await (await getAnonymousInventoryActor()).get_config();
      const entry = entries.find(([key]) => key === CONFIG_KEY)?.[1];
      return entry && "PrincipalId" in entry ? Principal.from(entry.PrincipalId).toText() : null;
    } catch {
      return null;
    }
  })();
  return cached;
}

/** `undefined` while resolving, then the id or `null`. */
export function useStorageCanisterId(): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void resolveStorageCanisterId().then((resolved) => !cancelled && setId(resolved));
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}
