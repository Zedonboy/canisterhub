// Delegated-identity bridge for when this app is embedded in the
// dashboard via iframe (see `Overview.tsx`'s "View data" action /
// `CanisterViewData.tsx` on the dashboard side) - lets this app act as the
// signed-in dashboard user, scoped to only this one canister, instead of
// needing its own separate Internet Identity sign-in. Protocol (parent
// side: `frontend/src/lib/moduleDelegation.ts`, which has the full
// write-up):
//
//   1. This module generates a local, ephemeral Ed25519 keypair - the
//      private key never leaves this frame.
//   2. Posts `{ type: "REQUEST_MODULE_DELEGATION", moduleCanisterId,
//      additionalCanisterIds, ephemeralPublicKeyHex }` to `window.parent`.
//      `additionalCanisterIds` is the storage canister (see
//      `canisterId.ts::storageCanisterId`) item images are uploaded to.
//   3. The parent (if it has a real, non-anonymous identity, and agrees
//      `moduleCanisterId` is the canister it actually embedded) signs a
//      delegation from that identity's own session key to this ephemeral
//      key, scoped to `moduleCanisterId` plus every other canister of the
//      project (the parent grants them all; `additionalCanisterIds` is
//      kept for older dashboards that only granted what was asked), and
//      replies with
//      `{ type: "SCOPED_DELEGATION_RESPONSE", delegationChainJson }`.
//      Otherwise (or if it never replies at all - an older dashboard
//      build, one that doesn't implement this protocol, or simply not
//      embedded) this resolves to `null` and `auth.ts::resolveIdentity`
//      falls back to the standalone Internet Identity flow, same as
//      always.
//   4. This module combines the ephemeral key + that chain into a real
//      `DelegationIdentity` and uses it for every canister call.
//   5. A delegation is short-lived (the parent picks the lifetime - 1 hour
//      for the dashboard), so this module renews it by repeating steps 1-4
//      with a fresh ephemeral key, at 75% of its lifetime and again on demand
//      (`renewDelegation`) if a call is still rejected as expired. If the
//      parent no longer delegates (its own session ended), the old identity
//      is used until it truly expires, then `sessionEnded()` turns true and
//      the page asks the user to sign in again on the dashboard.
//
// Not embedded at all (`window.parent === window`) - this is simply never
// attempted.

import { DelegationChain, DelegationIdentity, Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Identity } from "@icp-sdk/core/agent";
import { inventoryCanisterId } from "./canisterId";
import { resolveStorageCanisterId } from "./storageCanister";

/** How long to wait for the parent to answer before giving up and falling
 * back to the standalone sign-in flow - generous for a same-tab
 * `postMessage` round trip (which normally completes in well under a
 * second), short enough that a dashboard build that never implements this
 * protocol doesn't leave the page hanging. */
const RESPONSE_TIMEOUT_MS = 5000;

/** Renew once this much of the delegation's lifetime has passed. */
const RENEW_AT_FRACTION = 0.75;
/** Never hand out an identity that expires within this long - a call needs
 * time to reach the replica, which rejects an expired delegation outright. */
const EXPIRY_SAFETY_MS = 3000;
/** When the parent declines a renewal, try again after this long (or half
 * the time the old delegation has left, if that is sooner). */
const RETRY_AFTER_MS = 30_000;
/** Never ask the parent more often than this on a page's own initiative. */
const MIN_GAP_MS = 5000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // A cross-origin parent can make even reading `window.parent` throw in
    // some older engines - still embedded either way.
    return true;
  }
}

interface Delegated {
  identity: Identity;
  /** ms since epoch - the earliest expiry anywhere in the chain. */
  expiresAt: number;
}

let current: Delegated | null = null;
let inFlight: Promise<void> | null = null;
let started = false;
let everDelegated = false;
/** Set when a lost session has been announced, so it is announced once. */
let announcedLost = false;
let lastAttemptAt = 0;
let epoch = 0;
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Called whenever the delegation is renewed or lost, so `auth.ts` can
 * re-resolve the identity. */
export function onDelegationChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps on every renewal: an agent built from an older delegation must not
 * be reused, even though the principal it acts as is unchanged. */
export function delegationEpoch(): number {
  return epoch;
}

function usable(d: Delegated | null): d is Delegated {
  return d !== null && Date.now() < d.expiresAt - EXPIRY_SAFETY_MS;
}

/** `true` once this page had a dashboard delegation and no longer does
 * (the dashboard stopped delegating and the last one expired) - the user
 * has to sign in again on the dashboard. */
export function sessionEnded(): boolean {
  return everDelegated && !usable(current);
}

function schedule(delay: number) {
  clearTimeout(renewTimer);
  renewTimer = setTimeout(() => void refresh(), Math.max(0, delay));
}

/** One renewal (or the first request) at a time. */
function refresh(): Promise<void> {
  lastAttemptAt = Date.now();
  inFlight ??= requestDelegatedIdentity()
    .catch(() => null)
    .then((next) => {
      if (next) {
        current = next;
        everDelegated = true;
        announcedLost = false;
        epoch++;
        schedule((next.expiresAt - Date.now()) * RENEW_AT_FRACTION);
        // if no renewal arrives in time, tell the page the moment this one
        // stops being usable instead of waiting for the next click
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(notify, Math.max(0, next.expiresAt - EXPIRY_SAFETY_MS - Date.now()) + 50);
        notify();
      } else if (usable(current)) {
        // parent said no (or didn't answer) but what we have still works
        schedule(Math.min(RETRY_AFTER_MS, (current!.expiresAt - Date.now()) / 2));
      } else {
        // Nothing usable left. Before a first success this is just "not a
        // delegating dashboard" - fall back to standalone sign-in as always.
        // After one, keep asking now and then in case the dashboard is back,
        // but announce the loss once - notifying on every failed attempt
        // would make the page re-check its identity, and so ask again, in a loop.
        if (everDelegated) schedule(RETRY_AFTER_MS);
        if (!announcedLost) {
          announcedLost = true;
          notify();
        }
      }
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** The identity to call canisters with, renewing it first if it is about to
 * expire; `null` if not embedded, if the parent never delegated, or if the
 * delegation has ended - `auth.ts::resolveIdentity` falls back to the
 * standalone sign-in flow in each of those cases, so this never throws. */
export async function getDelegatedIdentity(): Promise<Identity | null> {
  if (!isEmbedded()) return null;
  if (!started) {
    started = true;
    await refresh();
  } else if (inFlight) {
    await inFlight;
  } else if (!usable(current) && everDelegated && Date.now() - lastAttemptAt > MIN_GAP_MS) {
    // e.g. the laptop slept through the renewal timer
    await refresh();
  }
  return usable(current) ? current.identity : null;
}

/** Forces a fresh delegation now - for when a call was rejected as expired
 * (a sleeping laptop or a throttled background tab can miss the timer).
 * `true` if the page now holds a usable delegation. */
export async function renewDelegation(): Promise<boolean> {
  if (!isEmbedded() || !everDelegated) return false;
  await (inFlight ?? refresh());
  return usable(current);
}

function chainExpiry(chain: DelegationChain): number {
  const earliestNs = chain.delegations.reduce((min, d) => (d.delegation.expiration < min ? d.delegation.expiration : min), chain.delegations[0].delegation.expiration);
  return Number(earliestNs / 1_000_000n);
}

async function requestDelegatedIdentity(): Promise<Delegated | null> {
  const ephemeral = Ed25519KeyIdentity.generate();
  const ephemeralPublicKeyHex = bytesToHex(new Uint8Array(ephemeral.getPublicKey().toDer()));
  const moduleCanisterId = inventoryCanisterId();
  // Image upload talks to the storage canister directly, and a delegation is
  // scoped to specific canisters - so ask for that one too. The parent only
  // includes it if it is one of the project's own canisters.
  const storageId = await resolveStorageCanisterId();
  const additionalCanisterIds = storageId ? [storageId] : [];

  return new Promise<Delegated | null>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, RESPONSE_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      // The response's value only ever matters if it really came from our
      // own parent window - a correctness check, not the real security
      // boundary (that's entirely on the parent's side: it alone decides
      // who gets a signed delegation at all, and for which canister).
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; delegationChainJson?: unknown } | null;
      if (!data || typeof data !== "object") return;

      if (data.type === "SCOPED_DELEGATION_RESPONSE") {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        try {
          const chain = DelegationChain.fromJSON(data.delegationChainJson as Parameters<typeof DelegationChain.fromJSON>[0]);
          resolve({ identity: DelegationIdentity.fromDelegation(ephemeral, chain), expiresAt: chainExpiry(chain) });
        } catch {
          resolve(null);
        }
      } else if (data.type === "MODULE_DELEGATION_UNAVAILABLE") {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(null);
      }
    }

    window.addEventListener("message", onMessage);
    // The payload is only a public key, never a secret - safe to post
    // without knowing the parent's exact origin ahead of time.
    window.parent.postMessage({ type: "REQUEST_MODULE_DELEGATION", moduleCanisterId, additionalCanisterIds, ephemeralPublicKeyHex }, "*");
  });
}
