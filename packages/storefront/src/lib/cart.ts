// Cart state shared across the app (header badge, catalogue cards, cart
// page). Persisted per browser in localStorage as `{ [itemId]: quantity }`;
// prices and stock are never stored, only ids - the catalogue is the source
// of truth, so a changed price can't be checked out at a stale amount.

import { useSyncExternalStore } from "react";

const KEY = "storefront-cart";
type Lines = Record<number, number>;

let lines: Lines = read();
const listeners = new Set<() => void>();

function read(): Lines {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Lines;
    return Object.fromEntries(Object.entries(raw).filter(([, q]) => Number.isInteger(q) && q > 0).map(([id, q]) => [Number(id), q]));
  } catch {
    return {};
  }
}

function commit(next: Lines) {
  lines = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not persisted; still works for this page load.
  }
  listeners.forEach((l) => l());
}

export const cart = {
  set(id: number, quantity: number) {
    const next = { ...lines };
    if (quantity <= 0) delete next[id];
    else next[id] = Math.min(quantity, 99);
    commit(next);
  },
  add(id: number, by = 1) {
    cart.set(id, (lines[id] ?? 0) + by);
  },
  remove(id: number) {
    cart.set(id, 0);
  },
  clear() {
    commit({});
  },
};

export function useCart(): Lines {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => lines,
  );
}
