// Forwards this dashboard's own signed-in identity into an embedded
// module's iframe (e.g. `packages/table-browser`, reached via a
// canister's own "View data" action - see `CanisterViewData.tsx`), scoped
// to exactly the one canister that iframe is showing, so the module can
// act as the real signed-in user without its own separate Internet
// Identity login. Protocol (module side:
// `packages/table-browser/src/lib/parentDelegation.ts`):
//
//   1. The module generates a local ephemeral Ed25519 keypair and posts
//      `{ type: "REQUEST_MODULE_DELEGATION", moduleCanisterId,
//      ephemeralPublicKeyHex }` to this window (its `window.parent`).
//   2. If this dashboard has a real signed-in identity (see
//      `lib/auth.ts::resolveDelegationIdentity`) AND `moduleCanisterId`
//      matches the one canister this page actually embedded (never taken
//      on the module's own say-so alone), this signs a new delegation
//      from the session's own key to that ephemeral key, scoped to just
//      that canister, and replies with
//      `{ type: "SCOPED_DELEGATION_RESPONSE", delegationChainJson }`.
//      Otherwise it replies with
//      `{ type: "MODULE_DELEGATION_UNAVAILABLE", reason }`, so the module
//      can fall back to its own standalone sign-in instead of hanging.
//
// Every reply only ever goes to the exact iframe window this page
// rendered (an `event.source`/`iframe.contentWindow` identity check), at
// the exact origin `admin_panel_url` resolved to (`expectedOrigin`) - a
// delegation is real signing authority, not something to hand to just
// any window that happens to post a matching-shaped message.

import { DelegationChain, Ed25519PublicKey } from "@icp-sdk/core/identity";
import type { DerEncodedPublicKey } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { resolveDelegationIdentity } from "./auth";

/** 1 hour - short-lived on purpose: this scopes real signing authority to
 * a single canister for an embedded module, not a whole dashboard
 * session. */
const DELEGATION_TTL_MS = 60 * 60 * 1000;

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex-encoded public key");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

interface RequestModuleDelegation {
  type: "REQUEST_MODULE_DELEGATION";
  moduleCanisterId: string;
  ephemeralPublicKeyHex: string;
}

function isRequestModuleDelegation(data: unknown): data is RequestModuleDelegation {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === "REQUEST_MODULE_DELEGATION" &&
    typeof (data as { moduleCanisterId?: unknown }).moduleCanisterId === "string" &&
    typeof (data as { ephemeralPublicKeyHex?: unknown }).ephemeralPublicKeyHex === "string"
  );
}

/** Wires up the listener for one embedded module iframe - call once the
 * iframe element exists (e.g. in a `useEffect`), and call the returned
 * cleanup function on unmount or whenever the canister/iframe being shown
 * changes. `expectedOrigin` and `allowedCanisterId` together are the
 * whole security boundary: a request from any other origin, or naming any
 * other canister, is rejected outright rather than silently trusting the
 * module's own claim. */
export function setupModuleDelegationBridge(iframe: HTMLIFrameElement, expectedOrigin: string, allowedCanisterId: string): () => void {
  async function onMessage(event: MessageEvent) {
    if (event.origin !== expectedOrigin) return;
    if (event.source !== iframe.contentWindow) return;
    if (!isRequestModuleDelegation(event.data)) return;

    const reply = (message: Record<string, unknown>) => {
      iframe.contentWindow?.postMessage(message, expectedOrigin);
    };

    if (event.data.moduleCanisterId !== allowedCanisterId) {
      reply({ type: "MODULE_DELEGATION_UNAVAILABLE", reason: "canister id does not match this embed" });
      return;
    }

    const parentIdentity = await resolveDelegationIdentity();
    if (!parentIdentity) {
      reply({ type: "MODULE_DELEGATION_UNAVAILABLE", reason: "not signed in" });
      return;
    }

    let modulePublicKey: Ed25519PublicKey;
    try {
      modulePublicKey = Ed25519PublicKey.fromDer(hexToBytes(event.data.ephemeralPublicKeyHex) as unknown as DerEncodedPublicKey);
    } catch {
      reply({ type: "MODULE_DELEGATION_UNAVAILABLE", reason: "invalid public key" });
      return;
    }

    const chain = await DelegationChain.create(parentIdentity, modulePublicKey, new Date(Date.now() + DELEGATION_TTL_MS), {
      previous: parentIdentity.getDelegation(),
      targets: [Principal.fromText(allowedCanisterId)],
    });

    reply({ type: "SCOPED_DELEGATION_RESPONSE", delegationChainJson: chain.toJSON() });
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
