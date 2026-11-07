import { getBackendActor } from "./actors";
import type { InstalledPackage, PackageInfo } from "../bindings/backend";
import type { Project } from "./backend";

export type { InstalledPackage, PackageInfo };

export function packageNameFromUrl(url: string): string {
  const name = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  if (!name?.endsWith(".wasm")) throw new Error(`Package URL does not end with a .wasm filename: ${url}`);
  return name;
}

export async function listPackageInfos(): Promise<PackageInfo[]> {
  const actor = await getBackendActor();
  return actor.list_package_infos();
}

/** Groups project canisters by their backend-derived Wasm artifact name. */
export async function projectPackageCanistersByName(project: Project): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const canister of Object.values(project.canisters)) {
    if (!canister.packageName) continue;
    (result[canister.packageName] ??= []).push(canister.id);
  }
  return result;
}

export async function getPackageInfo(packageName: string): Promise<PackageInfo | null> {
  const actor = await getBackendActor();
  return actor.get_package_info(packageName);
}

export async function listProjectPackageInstallations(projectId: string): Promise<InstalledPackage[]> {
  const actor = await getBackendActor();
  const result = await actor.list_project_package_installations(projectId);
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok;
}

export async function recordProjectPackageInstallation(
  projectId: string,
  canisterName: string,
  packageName: string,
): Promise<InstalledPackage> {
  const actor = await getBackendActor();
  const result = await actor.record_project_package_installation(projectId, canisterName, packageName);
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hyphenated(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolves an assigned backend package id without requiring upload files to
 * know that id. SHA is strongest, followed by the immutable release URL and
 * finally the human title/slug used by older marketplace records. */
export async function findPackageInfoForRelease(reference: {
  sha?: string;
  url?: string;
  title?: string;
}): Promise<PackageInfo | null> {
  const packages = await listPackageInfos();
  const normalizedTitle = reference.title ? hyphenated(reference.title) : null;
  return packages.find((pkg) =>
    (reference.sha && pkg.sha === reference.sha)
    || (reference.url && pkg.url === reference.url)
    || (normalizedTitle && hyphenated(pkg.name) === normalizedTitle)
  ) ?? null;
}

export function packageShaHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/** Downloads a release in the user's browser and refuses to return it unless
 * its bytes match the on-chain package catalog. */
export async function fetchVerifiedPackageWasm(pkg: PackageInfo): Promise<Uint8Array> {
  const response = await fetch(pkg.url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) throw new Error(`Could not download ${pkg.name}: HTTP ${response.status}`);
  const wasm = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", wasm.slice().buffer));
  const actualSha = bytesToHex(digest);
  if (actualSha !== pkg.sha) {
    throw new Error(`Downloaded ${pkg.name} SHA-256 mismatch (expected ${pkg.sha}, received ${actualSha})`);
  }
  return wasm;
}
