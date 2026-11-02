import { useCallback, useEffect, useState } from "react";
import { inventoryApi, UnauthorizedError } from "./api";
import type { Business, InventoryItem, Order } from "./types";

export type LoadError = { kind: "unauthorized" } | { kind: "failed"; message: string };

/** `identityKey` changes when the caller's principal does (sign in/out), so
 * data is refetched under the new identity. */
export function useInventory(enabled: boolean, identityKey: string | null) {
  const [business, setBusiness] = useState<Business | null>(null);
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<LoadError | null>(null);

  const reload = useCallback(async () => {
    try {
      const [b, i, o] = await Promise.all([inventoryApi.getBusiness(), inventoryApi.listItems(), inventoryApi.listOrders()]);
      setBusiness(b);
      setItems(i);
      setOrders(o);
      setError(null);
    } catch (e) {
      setError(e instanceof UnauthorizedError ? { kind: "unauthorized" } : { kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // `enabled` is false until the identity (delegated / signed in / anonymous)
  // has resolved, so the first call already carries the right principal.
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, identityKey, reload]);

  return { business, items, orders, error, reload };
}
