import { useCallback, useEffect, useState } from "react";
import { restaurantApi, type MenuItem, type Order } from "./api";

export type RestaurantLoadError = { kind: "unauthorized" } | { kind: "failed"; message: string };

export function useRestaurant(enabled: boolean, identityKey: string | null) {
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<RestaurantLoadError | null>(null);
  const reload = useCallback(async () => {
    try {
      const [nextMenu, nextOrders] = await Promise.all([
        restaurantApi.listMenu(), restaurantApi.listOrders(),
      ]);
      setMenu(nextMenu);
      setOrders(nextOrders.sort((a, b) => Number(b.created_at - a.created_at)));
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message.includes("controller access required") ? { kind: "unauthorized" } : { kind: "failed", message });
    }
  }, []);
  useEffect(() => { if (enabled) void reload(); }, [enabled, identityKey, reload]);
  return { menu, orders, error, reload };
}
