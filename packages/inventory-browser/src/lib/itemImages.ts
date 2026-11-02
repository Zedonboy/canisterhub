// Item photos live on a separate asset-storage canister, uploaded straight
// from the browser with the official `AssetManager` from
// `@icp-sdk/canisters/assets` - the same class the dashboard's Storage page
// uses - as the signed-in (or delegated) user, who needs Commit permission
// there. The resulting public URL is then saved on the item itself
// (`image_url` on `order_inventory`); this module never lists or looks
// anything up afterwards, so an item's picture is just `item.imageUrl`.

import { AssetManager } from "@icp-sdk/canisters/assets";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { network } from "./canisterId";
import { withSession } from "./session";
import { resolveStorageCanisterId } from "./storageCanister";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ROOT = "/inventory";

async function requireStorage(): Promise<string> {
  const id = await resolveStorageCanisterId();
  if (!id) throw new Error("No storage canister is configured for image uploads.");
  return id;
}

async function manager(storageId: string): Promise<AssetManager> {
  return new AssetManager({ agent: await getAgent(), canisterId: Principal.fromText(storageId) });
}

/** The public URL of one stored key. Local replicas serve canisters on
 * `<id>.localhost` at the same gateway port this page itself came from. */
export function imageUrl(storageId: string, key: string): string {
  if (network() === "ic") return `https://${storageId}.icp0.io${key}`;
  const port = window.location.port ? `:${window.location.port}` : "";
  return `http://${storageId}.localhost${port}${key}`;
}

/** `null` if `file` is fine to upload, otherwise a message for the user. */
export function validateImage(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file (PNG, JPG, WebP, …).";
  if (file.size > MAX_IMAGE_BYTES) return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`;
  return null;
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "image";
}

/** Uploads `file` and returns its public URL. Every upload gets its own
 * folder, so a replacement is always a new URL (no stale browser or
 * certified-asset cache) and needs no item id - which lets a brand-new
 * item be created with its image in one call. */
export async function uploadItemImage(file: File): Promise<string> {
  const problem = validateImage(file);
  if (problem) throw new Error(problem);
  const storageId = await requireStorage();
  const path = `${ROOT}/${crypto.randomUUID()}`;
  const key = await withSession(async () =>
    (await manager(storageId)).store(file, { path, fileName: safeName(file.name), contentType: file.type })
  );
  return imageUrl(storageId, key);
}

/** Best-effort removal of a file this app uploaded earlier, found from the
 * URL saved on the item. Anything that isn't one of ours on the configured
 * storage canister is left alone, and failures are swallowed - an orphaned
 * file is harmless, and it must never block saving the item. */
export async function deleteItemImage(url: string): Promise<void> {
  try {
    const storageId = await resolveStorageCanisterId();
    if (!storageId) return;
    const { hostname, pathname } = new URL(url);
    if (!hostname.startsWith(`${storageId}.`) || !pathname.startsWith(`${ROOT}/`)) return;
    await withSession(async () => (await manager(storageId)).delete(decodeURIComponent(pathname)));
  } catch {
    // see above
  }
}
