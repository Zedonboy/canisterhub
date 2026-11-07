import { AssetManager } from "@icp-sdk/canisters/assets";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { network } from "./canisterId";
import { withSession } from "./session";
import { resolveStorageCanisterId } from "./storageCanister";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ROOT = "/restaurant";

export function validateImage(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file (PNG, JPG, WebP, etc.).";
  if (file.size > MAX_IMAGE_BYTES) return `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`;
  return null;
}

function imageUrl(storageId: string, key: string): string {
  if (network() === "ic") return `https://${storageId}.icp0.io${key}`;
  const localGateway = window.location.port === "8000" || window.location.hostname.endsWith(".localhost");
  const port = localGateway ? (window.location.port ? `:${window.location.port}` : "") : ":8000";
  return `http://${storageId}.localhost${port}${key}`;
}

function filename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "dish-image";
}

export async function uploadItemImage(file: File): Promise<string> {
  const problem = validateImage(file);
  if (problem) throw new Error(problem);
  const storageId = await resolveStorageCanisterId();
  if (!storageId) throw new Error("Configure a Storage Canister in restaurant settings before uploading photos.");
  const key = await withSession(async () => new AssetManager({ agent: await getAgent(), canisterId: Principal.fromText(storageId) })
    .store(file, { path: `${ROOT}/${crypto.randomUUID()}`, fileName: filename(file.name), contentType: file.type }));
  return imageUrl(storageId, key);
}

export async function deleteItemImage(url: string): Promise<void> {
  try {
    const storageId = await resolveStorageCanisterId();
    if (!storageId) return;
    const parsed = new URL(url);
    if (!parsed.hostname.startsWith(`${storageId}.`) || !parsed.pathname.startsWith(`${ROOT}/`)) return;
    await withSession(async () => new AssetManager({ agent: await getAgent(), canisterId: Principal.fromText(storageId) }).delete(decodeURIComponent(parsed.pathname)));
  } catch { /* An orphaned file must not block the menu save. */ }
}
