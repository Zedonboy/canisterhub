// Web Push for the customer chat: subscribes this browser to the project's
// notification canister under the customer's own principal, so the agent can
// push "new reply" when the team answers (see `packages/agent/src/push.rs`).
// The app-shell service worker (`public/sw.js`) shows the notification.
import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { notificationCanisterId } from "./canisterId";
import { resolveCustomerIdentity } from "./customerAuth";
import { idlFactory, type NotificationService } from "./candid/notification";

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function notificationActor(): Promise<NotificationService> {
  const id = notificationCanisterId();
  if (!id) throw new Error("Notifications aren't set up for this chat.");
  const agent = await getAgent(await resolveCustomerIdentity());
  return Actor.createActor<NotificationService>(idlFactory, { agent, canisterId: Principal.fromText(id) });
}

/** Asks for permission, subscribes this browser and records it. */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("This browser doesn't support push notifications.");
  const actor = await notificationActor();
  const key = await actor.push_vapid_public_key();
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
