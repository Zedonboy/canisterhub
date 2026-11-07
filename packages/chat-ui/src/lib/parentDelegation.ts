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
//      ephemeralPublicKeyHex }` to `window.parent`.
//   3. The parent (if it has a real, non-anonymous identity, and agrees
//      `moduleCanisterId` is the canister it actually embedded) signs a
//      delegation from that identity's own session key to this ephemeral
//      key, scoped to `moduleCanisterId` plus every other canister of the
//      project (so this page can call any of them), and replies with
//      `{ type: "SCOPED_DELEGATION_RESPONSE", delegationChainJson }`.
//      Otherwise (or if it never replies at all - an older dashboard
//      build, one that doesn't implement this protocol, or simply not
//      embedded) this resolves to `null` and `auth.ts::resolveIdentity`
//      falls back to the standalone Internet Identity flow, same as
//      always.
//   4. This module combines the ephemeral key + that chain into a real
//      `DelegationIdentity` and uses it for every canister call.
//
// Not embedded at all (`window.parent === window`) - this is simply never
// attempted.

import { DelegationChain, DelegationIdentity, Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Identity } from "@icp-sdk/core/agent";
import { agentCanisterId } from "./canisterId";

/** How long to wait for the parent to answer before giving up and falling
 * back to the standalone sign-in flow - generous for a same-tab
 * `postMessage` round trip (which normally completes in well under a
 * second), short enough that a dashboard build that never implements this
 * protocol doesn't leave the page hanging. */
const RESPONSE_TIMEOUT_MS = 5000;
export const DELEGATION_REFRESH_EVENT = "chat-ui:delegation-refreshed";

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

let delegatedIdentityPromise: Promise<Identity | null> | null = null;
let delegationIssue: string | null = null;

export function getDelegationIssue(): string | null {
  return delegationIssue;
}

/** Best-effort, memoized for the lifetime of this page load: `null` if
 * not embedded, if the parent has no real identity to delegate, or if it
 * simply never answers - `auth.ts::resolveIdentity` falls back to the
 * standalone sign-in flow in every one of those cases, so this never
 * throws. */
export function getDelegatedIdentity(): Promise<Identity | null> {
  if (!isEmbedded()) return Promise.resolve(null);
  delegatedIdentityPromise ??= requestDelegatedIdentity()
    .then((identity) => {
      if (identity) delegationIssue = null;
      else delegationIssue ??= "The dashboard did not provide a secure session.";
      return identity;
    })
    .catch(() => {
      delegationIssue = "The dashboard could not provide a secure session.";
      return null;
    });
  return delegatedIdentityPromise;
}

/** Starts a fresh parent handshake after a delegated session expires. */
export function retryDelegatedIdentity(): Promise<Identity | null> {
  if (!isEmbedded()) return Promise.resolve(null);
  delegationIssue = null;
  delegatedIdentityPromise = null;
  window.dispatchEvent(new Event(DELEGATION_REFRESH_EVENT));
  return getDelegatedIdentity();
}

function requestDelegatedIdentity(): Promise<Identity | null> {
  const ephemeral = Ed25519KeyIdentity.generate();
  const ephemeralPublicKeyHex = bytesToHex(new Uint8Array(ephemeral.getPublicKey().toDer()));
  const moduleCanisterId = agentCanisterId();

  return new Promise<Identity | null>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      delegationIssue = "The dashboard did not respond in time to the secure session request.";
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
          resolve(DelegationIdentity.fromDelegation(ephemeral, chain));
        } catch {
          delegationIssue = "The dashboard returned an invalid secure session.";
          resolve(null);
        }
      } else if (data.type === "MODULE_DELEGATION_UNAVAILABLE") {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        delegationIssue = "The dashboard is unable to share a secure session right now.";
        resolve(null);
      }
    }

    window.addEventListener("message", onMessage);
    // The payload is only a public key, never a secret - safe to post
    // without knowing the parent's exact origin ahead of time.
    window.parent.postMessage({ type: "REQUEST_MODULE_DELEGATION", moduleCanisterId, ephemeralPublicKeyHex }, "*");
  });
}
