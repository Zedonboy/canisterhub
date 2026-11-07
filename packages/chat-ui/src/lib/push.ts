// Web Push for the customer chat: subscribes this browser to the protocol
// backend under the customer's own principal.
// The app-shell service worker (`public/sw.js`) shows the notification.
import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { protocolBackendId } from "./canisterId";
import { resolveCustomerIdentity } from "./customerAuth";
import { idlFactory, type BackendPushService } from "./candid/protocolPush";

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function backendPushActor(): Promise<BackendPushService> {
  const agent = await getAgent(await resolveCustomerIdentity());
  return Actor.createActor<BackendPushService>(idlFactory, { agent, canisterId: Principal.fromText(protocolBackendId()) });
}

/** Asks for permission, subscribes this browser and records it. */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("This browser doesn't support push notifications.");
  const actor = await backendPushActor();
  const key = await actor.push_ensure_vapid();
  if ("Err" in key) throw new Error(key.Err);

  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("Notification permission wasn't granted.");
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(key.Ok),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  const result = await actor.push_subscribe({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  });
  if ("Err" in result) throw new Error(result.Err);
}
