import { Principal } from "@icp-sdk/core/principal";
import { useEffect, useState } from "react";
import { getAnonymousRestaurantActor } from "./actor";
import { storageCanisterIdFromEnv } from "./canisterId";

let cached: Promise<string | null> | null = null;
export function resolveStorageCanisterId(): Promise<string | null> {
  cached ??= (async () => {
    const fromEnv = storageCanisterIdFromEnv();
    if (fromEnv) return fromEnv;
    try {
      const entries = await (await getAnonymousRestaurantActor()).get_config();
      const value = entries.find(([key]) => key === "storage_canister")?.[1];
      return value && "PrincipalId" in value ? Principal.from(value.PrincipalId).toText() : null;
    } catch { return null; }
  })();
  return cached;
}

export function useStorageCanisterId(): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => { let cancelled = false; void resolveStorageCanisterId().then((value) => { if (!cancelled) setId(value); }); return () => { cancelled = true; }; }, []);
  return id;
}
