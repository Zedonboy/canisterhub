// Hash routing, so the storefront works at any mount path of the canister
// and inside an iframe without server-side rewrites. Every view has its own
// URL: `#/`, `#/item/<id>`, `#/cart`, `#/orders`.

import { useEffect, useState } from "react";

export type Route =
  | { page: "catalog" }
  | { page: "item"; id: number }
  | { page: "cart" }
  | { page: "orders"; placed?: number };

export function parseRoute(hash = window.location.hash): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "item" && /^\d+$/.test(parts[1] ?? "")) return { page: "item", id: Number(parts[1]) };
  if (parts[0] === "cart") return { page: "cart" };
  if (parts[0] === "orders") {
    const placed = new URLSearchParams(query).get("placed");
    return { page: "orders", placed: placed && /^\d+$/.test(placed) ? Number(placed) : undefined };
  }
  return { page: "catalog" };
}

export function navigate(to: string) {
  window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** `?embed=1` on the page URL: compact layout for use inside an iframe. */
export const EMBED = new URLSearchParams(window.location.search).get("embed") === "1";
