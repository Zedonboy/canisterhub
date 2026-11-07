// Real browser Web Push subscribe/unsubscribe against the protocol backend.

import { getBackendActor } from "./actors";

const SERVICE_WORKER_URL = "/sw.js";
const SERVICE_WORKER_SCOPE = "/";

async function waitUntilActive(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error("The notification service worker did not start.");
  await new Promise<void>((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") resolve();
      if (worker.state === "redundant") reject(new Error("The notification service worker failed to activate."));
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

export function isPushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

/** Real current state, not a locally-cached guess: `"denied"` reflects the
 * browser's own permission state (nothing short of the user changing it in
 * their browser settings can undo this), `"enabled"` means this exact
 * browser currently holds a live `PushSubscription`, `"disabled"` covers
 * everything else (including "never asked yet"). */
export async function getPushStatus(): Promise<"enabled" | "disabled" | "denied"> {
  if (!isPushSupported()) return "disabled";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "enabled" : "disabled";
}

/** Registers the service worker, requests notification permission, creates
 * a real `PushSubscription` against the backend canister's VAPID public key,
 * and records it under the signed-in caller's principal. */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("This browser doesn't support push notifications.");
  }

  const actor = await getBackendActor();
  const keyResult = await actor.push_ensure_vapid();
  if ("Err" in keyResult) throw new Error(keyResult.Err);
  const applicationServerKey = new Uint8Array(keyResult.Ok);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: SERVICE_WORKER_SCOPE,
  });
  await waitUntilActive(registration);
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }

  const result = await actor.push_subscribe({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
  if ("Err" in result) throw new Error(result.Err);
}

/** Unsubscribes this browser and removes its backend record. The backend
 * also prunes stale records automatically when a push service returns
 * HTTP 404 or 410. */
export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  const actor = await getBackendActor();
  const result = await actor.push_unsubscribe(endpoint);
  if ("Err" in result) throw new Error(result.Err);
  await subscription.unsubscribe();
}
