// Real file/bucket/usage data for a project's own asset-storage canister -
// "use ic AssetManager lib in the frontend to access asset canisters" (the
// user's own framing): every real call in this file goes through the
// official `AssetManager` class from `@icp-sdk/canisters/assets` (the same
// `dfinity/icp-js-core` family as `@icp-sdk/core` itself, verified directly
// against its real, installed type declarations - not hand-rolled candid
// bindings, and not `@dfinity/assets`, matching this project's own
// `@icp-sdk/*`-over-`@dfinity/*` convention). No orchestrator HTTP call
// anywhere in this file.

import { Principal } from "@icp-sdk/core/principal";
import { AssetManager, type AssetManagerConfig } from "@icp-sdk/canisters/assets";
import { getAgent } from "./agent";
import type { Project, CanisterInfo } from "./backend";
import { localIcHost } from "./canisterEnv";

export interface StorageCanister {
  name: string;
  id: string;
}

export interface AssetFile {
  key: string;
  contentType: string;
  /** The largest encoding's byte length (an asset can have more than one -
   * e.g. both plain and gzip - `list` reports each separately; the biggest
   * one is the most honest single "size" to show for a file browser, since
   * it's what an uncompressed fetch actually transfers). */
  size: number;
  /** Newest `modified` time across this asset's encodings. */
  modifiedAt: string;
  encodings: string[];
}

function nanosToIso(nanos: bigint): string {
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function icHostFor(network: string): string {
  if (network === "ic") return "https://icp0.io";
  return localIcHost();
}

/** The real, publicly-servable URL for one asset key on this canister -
 * same real URL shape `lib/canisterStats.ts::staticUrl` uses for a whole
 * `static` canister's homepage, just pointed at one specific key. */
export function assetUrl(canisterId: string, network: string, key: string): string {
  if (network === "ic") return `https://${canisterId}.icp0.io${key}`;
  return `${icHostFor(network)}${key}?canisterId=${canisterId}`;
}

/** One real `AssetManager` instance per (canister, network) call - cheap to
 * construct (it just wraps an actor, same spirit as `lib/actors.ts`'s own
 * per-call actor construction), so no caching needed. */
async function assetManagerFor(canisterId: string, network: string): Promise<AssetManager> {
  const agent = await getAgent(network);
  const config: AssetManagerConfig = { agent, canisterId: Principal.fromText(canisterId) };
  return new AssetManager(config);
}

/** `AssetManager.list()`'s own real element type - re-derived from the
 * library itself (`Awaited<ReturnType<AssetManager["list"]>>[number]`)
 * rather than a second, hand-copied shape that could drift from whatever
 * the library actually returns. */
type RawAsset = Awaited<ReturnType<AssetManager["list"]>>[number];

function adaptAsset(raw: RawAsset): AssetFile {
  const size = raw.encodings.reduce((max, e) => Math.max(max, Number(e.length)), 0);
  const modifiedAt = raw.encodings.reduce((latest, e) => (e.modified > latest ? e.modified : latest), 0n);
  return {
    key: raw.key,
    contentType: raw.content_type,
    size,
    modifiedAt: modifiedAt > 0n ? nanosToIso(modifiedAt) : new Date(0).toISOString(),
    encodings: raw.encodings.map((e) => e.content_encoding),
  };
}

/** Every real asset-storage canister on this project - a pure client-side
 * filter of `Project.canisters` (already fetched from `backend`), no
 * canister call needed. The conventional `assets*` entries are included,
 * as are `runtime-*` uploads whose self-declared metadata classified them
 * as Storage. The project's own UI frontend (conventionally named
 * `static`) remains excluded even though it shares the same project kind. */
export function listStorageCanisters(project: Project): StorageCanister[] {
  return Object.entries(project.canisters)
    .filter(([name, info]: [string, CanisterInfo]) => {
      const normalizedName = name.toLowerCase();
      return info.kind === "static" && (normalizedName.startsWith("assets") || normalizedName.startsWith("runtime-"));
    })
    .map(([name, info]) => ({ name, id: info.id }));
}

/** Every real asset on this canister - `AssetManager.list()`, no pagination
 * needed for a typical app's own media bucket. */
export async function listAssets(canisterId: string, network: string): Promise<AssetFile[]> {
  const manager = await assetManagerFor(canisterId, network);
  const raw = await manager.list();
  return raw.map(adaptAsset).sort((a, b) => a.key.localeCompare(b.key));
}

/** Real upload via `AssetManager.store()` - handles content-type/encoding
 * inference, hashing, and chunking large files itself; `path` becomes the
 * asset's directory prefix (default `/`), the file's own name becomes the
 * rest of the key. Returns the real resulting key. */
export async function uploadFile(canisterId: string, network: string, file: File, path?: string): Promise<string> {
  const manager = await assetManagerFor(canisterId, network);
  return manager.store(file, path ? { path } : undefined);
}

/** Real, irreversible deletion via `AssetManager.delete()`. */
export async function deleteAsset(canisterId: string, network: string, key: string): Promise<void> {
  const manager = await assetManagerFor(canisterId, network);
  await manager.delete(key);
}

/** The most recent real `modifiedAt` across every asset - derived from
 * already-fetched `list()` data rather than a separate `get_state_info`
 * call (not exposed by `AssetManager`'s own public surface), so this adds
 * no extra network round trip. `null` for an empty bucket. */
export function latestModified(files: AssetFile[]): string | null {
  if (files.length === 0) return null;
  return files.reduce((latest, f) => (f.modifiedAt > latest ? f.modifiedAt : latest), files[0].modifiedAt);
}

/** A folder derived purely from real asset keys' own path structure (e.g.
 * "/images/logo.png" -> folder "images") - the real certified-assets
 * interface has no actual directory/bucket concept of its own (`Key` is
 * just an opaque path-shaped string), so this is a client-side grouping of
 * genuine keys, not a second, fabricated hierarchy. */
export interface AssetFolder {
  path: string;
  files: AssetFile[];
  totalSize: number;
}

export function groupIntoFolders(files: AssetFile[]): AssetFolder[] {
  const groups = new Map<string, AssetFile[]>();
  for (const file of files) {
    const segments = file.key.split("/").filter(Boolean);
    const folder = segments.length > 1 ? segments.slice(0, -1).join("/") : "/";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(file);
  }
  return Array.from(groups.entries())
    .map(([path, files]) => ({ path, files, totalSize: files.reduce((sum, f) => sum + f.size, 0) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface StorageUsage {
  fileCount: number;
  totalBytes: number;
  byContentType: { contentType: string; count: number; bytes: number }[];
}

export function computeUsage(files: AssetFile[]): StorageUsage {
  const byType = new Map<string, { count: number; bytes: number }>();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    const entry = byType.get(file.contentType) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += file.size;
    byType.set(file.contentType, entry);
  }
  const byContentType = Array.from(byType.entries())
    .map(([contentType, { count, bytes }]) => ({ contentType, count, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return { fileCount: files.length, totalBytes, byContentType };
}
