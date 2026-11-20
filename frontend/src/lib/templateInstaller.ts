import { parse } from "smol-toml";
import { Principal } from "@icp-sdk/core/principal";
import packageSeed from "../../../scripts/package-seed.json";
import foodOrderingManifest from "../../../Templates/food-order-service/canister_hub.toml?raw";
import inventoryOrderingManifest from "../../../Templates/ai-inventory-ordering/canister_hub.toml?raw";
import { MarketplaceItemType, type MarketplaceItem } from "../bindings/backend";
import { getPackageInfo, fetchVerifiedPackageWasm, type PackageInfo } from "./packageRegistry";
import { getModuleConfigSchema, setModuleConfig, type ConfigFieldSchema, type ConfigType, type ConfigValue, type ConfigVectorType, type ConfigVectorValue } from "./moduleConfig";
import { deployPackageInfo } from "./deploy";
import type { DeployedCanister } from "./deploy";

const CYCLES_PER_PACKAGE = 2_000_000_000_000n;
const BUNDLED_MANIFESTS: Record<string, string> = {
  "ai-food-ordering": foodOrderingManifest,
  "ai-inventory-ordering": inventoryOrderingManifest,
};

interface ManifestPackage {
  name: string;
  package_name: string;
  depends_on?: string[];
}

interface TemplateManifest {
  schema_version: number;
  template?: { name?: string };
  packages: ManifestPackage[];
  config?: Record<string, Record<string, unknown>>;
}

export interface TemplateInstallPackage {
  alias: string;
  packageName: string;
  packageInfo: PackageInfo;
  dependsOn: string[];
}

export interface PreparedTemplateInstall {
  manifest: TemplateManifest;
  packages: TemplateInstallPackage[];
}

export const templateCyclesEstimate = (packageCount: number): bigint => CYCLES_PER_PACKAGE * BigInt(packageCount);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function templateSeedFor(item: MarketplaceItem) {
  if (item.item_type !== MarketplaceItemType.Template) throw new Error("This marketplace item is not a template.");
  return packageSeed.templates.find((template) =>
    template.package_slug === item.package_slug
    && template.git_repo_url.replace(/\/+$/, "").toLowerCase() === item.git_repo_url.replace(/\/+$/, "").toLowerCase(),
  );
}

function orderPackages(packages: ManifestPackage[]): ManifestPackage[] {
  const byName = new Map<string, ManifestPackage>();
  for (const pkg of packages) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(pkg.name)) throw new Error(`Invalid template package alias '${pkg.name}'.`);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}(?:\.wasm)?$/.test(pkg.package_name)) {
      throw new Error(`Invalid package_name '${pkg.package_name}' for '${pkg.name}'.`);
    }
    if (byName.has(pkg.name)) throw new Error(`Template has duplicate package alias '${pkg.name}'.`);
    byName.set(pkg.name, pkg);
  }

  const ordered: ManifestPackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`Template depends on unknown package alias '${name}'.`);
    if (visiting.has(name)) throw new Error(`Template package dependencies contain a cycle at '${name}'.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of pkg.depends_on ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(pkg);
  };
  for (const pkg of packages) visit(pkg.name);
  return ordered;
}

/** Downloads the R2 manifest selected by the seed file, verifies its exact
 * backend-recorded SHA-256, then resolves every manifest package through the
 * backend registry. Manifest Wasm URLs are never used as install sources. */
export async function prepareTemplateInstall(item: MarketplaceItem): Promise<PreparedTemplateInstall> {
  const seed = templateSeedFor(item);
  if (!seed?.download_url) throw new Error("This template is not configured in the package seed file.");
  const expectedHash = bytesToHex(item.wasm_hash);
  let manifestText: string | null = null;
  let downloadError: string | null = null;
  try {
    const response = await fetch(seed.download_url, { redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifestText = new TextDecoder().decode(await response.arrayBuffer());
    const actualHash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifestText))));
    if (actualHash !== expectedHash) {
      downloadError = `downloaded manifest SHA-256 mismatch (received ${actualHash})`;
      manifestText = null;
    }
  } catch (error) {
    downloadError = error instanceof Error ? error.message : String(error);
  }
  if (manifestText === null) {
    const bundled = BUNDLED_MANIFESTS[item.package_slug];
    if (!bundled) throw new Error(`Could not download the template manifest: ${downloadError ?? "unknown error"}.`);
    const bundledHash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundled))));
    if (bundledHash !== expectedHash) {
      throw new Error(`Template manifest could not be verified: ${downloadError ?? "download failed"}; the bundled manifest also does not match the backend SHA-256.`);
    }
    manifestText = bundled;
  }

  let manifest: TemplateManifest;
  try {
    manifest = parse(manifestText) as unknown as TemplateManifest;
  } catch (error) {
    throw new Error(`Template manifest is invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.schema_version !== 2 || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("Template manifest must use schema_version 2 and include at least one package.");
  }

  const orderedPackages = orderPackages(manifest.packages);
  const aliases = new Set(orderedPackages.map((pkg) => pkg.name));
  for (const [alias, values] of Object.entries(manifest.config ?? {})) {
    if (!aliases.has(alias)) throw new Error(`Template configuration refers to unknown package alias '${alias}'.`);
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`Template configuration for '${alias}' must be a TOML table.`);
    }
  }
  const packages = await Promise.all(orderedPackages.map(async (pkg) => {
    const packageName = pkg.package_name.endsWith(".wasm") ? pkg.package_name : `${pkg.package_name}.wasm`;
    const packageInfo = await getPackageInfo(packageName);
    if (!packageInfo) throw new Error(`Package '${packageName}' from this template is missing from the backend package registry.`);
    return { alias: pkg.name, packageName, packageInfo, dependsOn: pkg.depends_on ?? [] };
  }));
  return { manifest, packages };
}

function resolveTemplateString(value: string, canisters: Map<string, string>, projectId: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, reference: string) => {
    if (reference === "project.id") return projectId;
    const match = /^([a-z][a-z0-9_-]*)\.canister_id$/.exec(reference);
    if (!match) throw new Error(`Unsupported template reference \u0024{${reference}}.`);
    const canisterId = canisters.get(match[1]);
    if (!canisterId) throw new Error(`Template reference '${reference}' could not be resolved.`);
    return canisterId;
  });
}

function principalValue(raw: unknown, canisters: Map<string, string>, projectId: string): Extract<ConfigValue, { PrincipalId: Principal }> {
  if (typeof raw !== "string") throw new Error("A canister setting must be a template reference string.");
  return { PrincipalId: Principal.fromText(resolveTemplateString(raw, canisters, projectId)) };
}

function vectorValue(type: ConfigVectorType, raw: unknown, canisters: Map<string, string>, projectId: string): ConfigVectorValue {
  if ("CanisterPicker" in type) {
    const value = principalValue(raw, canisters, projectId);
    return { PrincipalId: value.PrincipalId };
  }
  if ("Boolean" in type) {
    if (typeof raw !== "boolean") throw new Error("Expected a boolean template setting.");
    return { Boolean: raw };
  }
  if ("Number" in type) {
    if (typeof raw !== "number" && typeof raw !== "bigint") throw new Error("Expected an integer template setting.");
    return { Number: BigInt(raw) };
  }
  if ("Float" in type) {
    if (typeof raw !== "number") throw new Error("Expected a numeric template setting.");
    return { Float: raw };
  }
  if (typeof raw !== "string") throw new Error("Expected a text template setting.");
  return { Text: resolveTemplateString(raw, canisters, projectId) };
}

function configValue(type: ConfigType, raw: unknown, canisters: Map<string, string>, projectId: string): ConfigValue {
  if ("Vector" in type) {
    if (!Array.isArray(raw)) throw new Error("Expected a list for this template setting.");
    return { Vector: raw.map((value) => vectorValue(type.Vector.element_type, value, canisters, projectId)) };
  }
  if ("CanisterPicker" in type) return principalValue(raw, canisters, projectId);
  if ("Boolean" in type) {
    if (typeof raw !== "boolean") throw new Error("Expected a boolean template setting.");
    return { Boolean: raw };
  }
  if ("Number" in type) {
    if (typeof raw !== "number" && typeof raw !== "bigint") throw new Error("Expected an integer template setting.");
    return { Number: BigInt(raw) };
  }
  if ("Float" in type) {
    if (typeof raw !== "number") throw new Error("Expected a numeric template setting.");
    return { Float: raw };
  }
  if (typeof raw !== "string") throw new Error("Expected a text template setting.");
  return { Text: resolveTemplateString(raw, canisters, projectId) };
}

/** Applies only settings declared by the manifest, using each canister's
 * schema to encode values and the installed alias map to resolve canister IDs. */
export async function configureTemplatePackage(
  packageAlias: string,
  canisterId: string,
  network: string,
  values: Record<string, unknown> | undefined,
  canisters: Map<string, string>,
  projectId: string,
): Promise<void> {
  if (!values || Object.keys(values).length === 0) return;
  const schema = await getModuleConfigSchema(canisterId, network);
  const fields = new Map(schema.map((field) => [field.key, field]));
  const settings: Record<string, ConfigValue> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) throw new Error(`Package '${packageAlias}' has no dynamic setting named '${key}'.`);
    if (field.is_readonly?.[0]) continue;
    settings[key] = configValue(field.field_type, raw, canisters, projectId);
  }
  if (Object.keys(settings).length > 0) await setModuleConfig(canisterId, network, settings);
}

export async function installTemplatePackages(
  plan: PreparedTemplateInstall,
  network: string,
  projectId: string,
  user: Principal,
  onProgress: (message: string) => void,
): Promise<DeployedCanister[]> {
  const installed = new Map<string, string>();
  const deployedByAlias = new Map<string, DeployedCanister>();
  const deployed: DeployedCanister[] = [];
  for (const [index, pkg] of plan.packages.entries()) {
    onProgress(`Downloading and verifying ${pkg.packageName} (${index + 1}/${plan.packages.length})…`);
    const wasm = await fetchVerifiedPackageWasm(pkg.packageInfo);
    onProgress(`Installing ${pkg.packageName} (${index + 1}/${plan.packages.length})…`);
    const canister = await deployPackageInfo(pkg.packageInfo, network, projectId, user, wasm);
    installed.set(pkg.alias, canister.id);
    deployedByAlias.set(pkg.alias, canister);
    deployed.push(canister);
  }

  for (const pkg of plan.packages) {
    onProgress(`Configuring ${pkg.packageName}…`);
    await configureTemplatePackage(
      pkg.alias,
      deployedByAlias.get(pkg.alias)!.id,
      network,
      plan.manifest.config?.[pkg.alias],
      installed,
      projectId,
    );
  }
  return deployed;
}
