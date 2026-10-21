// Real browser Web Push subscribe/unsubscribe - no mock state. The VAPID
// public key and the subscribe/unsubscribe/list records all live on
// `orchestrator` now (see services/orchestrator/src/push.rs's doc comment
// for why this moved off `backend`), reached the same way
// templates.ts::deployTemplate reaches it: a short-lived JWT from
// `backend::issue_jwt`, then a bearer-authenticated fetch.

import { getBackendActor } from "./actors";
import { runtimeValue } from "./canisterEnv";

const SERVICE_WORKER_URL = "/sw.js";
const ORCHESTRATOR_URL = (runtimeValue("ORCHESTRATOR_URL") ?? "http://127.0.0.1:8787").replace(/\/$/, "");

async function readJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Orchestrator returned HTTP ${response.status}`);
  return value;
}

async function authHeaders(): Promise<Record<string, string>> {
  const actor = await getBackendActor();
  const tokenResult = await actor.issue_jwt();
  if ("Err" in tokenResult) throw new Error(tokenResult.Err);
  return { "Content-Type": "application/json", Authorization: `Bearer ${tokenResult.Ok}` };
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
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "enabled" : "disabled";
}

/** Registers the service worker, requests notification permission, creates
 * a real `PushSubscription` against the orchestrator's own VAPID public key,
 * and records it on the orchestrator. Throws with a clear message at
 * whichever step actually fails (permission denied, orchestrator
 * unreachable, VAPID key not configured on this deployment, etc.) rather
 * than swallowing it. */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("This browser doesn't support push notifications.");
  }

  const keyResponse = await fetch(`${ORCHESTRATOR_URL}/push/vapid-public-key`);
  const keyBody = await readJson(keyResponse);
  const applicationServerKey = new Uint8Array(keyBody.key);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }

  await readJson(
    await fetch(`${ORCHESTRATOR_URL}/push/subscribe`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
    }),
  );
}

/** Unsubscribes this browser and removes the matching record from the
 * orchestrator. Best-effort on that call (`.catch` swallows it): if the
 * browser-side `unsubscribe()` below succeeds but the orchestrator call
 * doesn't, the stale record is harmless (a push to a now-invalid endpoint
 * just fails silently on delivery) and shouldn't block the user from
 * turning notifications off in their own browser. */
export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  try {
    await fetch(`${ORCHESTRATOR_URL}/push/unsubscribe`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort - see this function's own doc comment.
  }
}
