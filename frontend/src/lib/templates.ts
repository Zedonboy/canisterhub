// Real, direct-from-the-browser project template deploy - no orchestrator
// involvement at all (that moved entirely client-side; see
// services/orchestrator/README.md's "API" section for why). This file
// parses+validates `canister_hub.toml` itself, installs each declared
// package the same direct way `lib/deploy.ts` installs a single
// marketplace item, and configures each one through its own `ic::config`
// surface (`get_config_schema`/`set_config` - see `lib/moduleConfig.ts`)
// rather than through a separate ad hoc candid-call mechanism: a package's
// own schema already gives every field a type, a default, and a
// required/optional flag, which is exactly what a template placeholder
// needs - so a template's `[config.<package>]` table just supplies literal
// overrides for that schema, and anything still required-and-unfilled
// gets prompted for in the UI (`pages/TemplateInstall.tsx`) before deploy
// continues.

import { parse } from "smol-toml";
import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";
import { getModuleConfigSchema, setModuleConfig } from "./moduleConfig";
import type { ConfigFieldSchema, ConfigType, ConfigValue, ConfigVectorType, ConfigVectorValue } from "./moduleConfig";
import { addProjectCanisters, getProject, type CanisterInfo } from "./backend";
import { getMarketplaceItem, listMarketplaceItems, recordDownload } from "./marketplace";
import { runtimeValue } from "./canisterEnv";
import { backendCanisterId } from "./actors";
import { MarketplaceItemType } from "../bindings/backend";

const MAX_PACKAGES = 32;

export interface TemplatePackage {
  name: string;
  url: string;
  required: boolean;
  depends_on: string[];
  /** Optional install (init) argument as base64 of the already-encoded
   * Candid bytes (`DIDL…`). Omitted means the empty tuple `()`. Candid
   * text may later be accepted alongside this; for now bytes only. */
  init_arg_base64?: string;
  /** Question shown next to an optional package's checkbox, e.g. "Add an
   * online storefront?". Falls back to the package name. */
  prompt?: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  slug: string;
  version: string;
  description: string;
  category: string;
  tags: string[];
  package_count: number;
  icon_url: string | null;
  download_count: bigint;
  featured: boolean;
}

/** A TOML-literal default for one package's config field - whatever
 * `smol-toml` parses a scalar or array into. Converted against that
 * field's own declared `ConfigType` (from its live `get_config_schema`)
 * by `literalToConfigValue` below, never guessed from the literal's own
 * shape. */
export type TemplateConfigLiteral = string | number | boolean | Array<string | number | boolean>;

export interface ProjectTemplate {
  schema_version: number;
  template: Omit<TemplateSummary, "id" | "package_count" | "icon_url" | "download_count" | "featured">;
  packages: TemplatePackage[];
  /** Keyed by package name, then by that package's own config field key -
   * literal overrides applied before prompting the user for anything
   * still required and unfilled. */
  config: Record<string, Record<string, TemplateConfigLiteral>>;
}

function isTemplateType(itemType: MarketplaceItemType): boolean {
  return itemType === MarketplaceItemType.Template;
}

const EMPTY_INIT_ARG = new Uint8Array([68, 73, 68, 76, 0, 0]);

/** Decodes a package's `init_arg_base64`, or `()` when it has none. Checks
 * for the Candid `DIDL` magic so a mistyped value fails when the manifest
 * loads, not after the canister is already created. */
function decodeInitArg(pkgName: string, encoded: string | undefined): Uint8Array {
  if (encoded === undefined) return EMPTY_INIT_ARG;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(encoded.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`package \`${pkgName}\` has an invalid init_arg_base64 (not valid base64)`);
  }
  if (bytes.length < 6 || bytes[0] !== 68 || bytes[1] !== 73 || bytes[2] !== 68 || bytes[3] !== 76) {
    throw new Error(`package \`${pkgName}\` init_arg_base64 is not Candid-encoded (must start with DIDL)`);
  }
  return bytes;
}

function isSafeSlug(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(value);
}

/** Dependency-ordered packages - every package after everything it
 * `depends_on`. Throws if the graph has a cycle (ported from the
 * orchestrator's now-removed `TemplateManifest::ordered_packages`, which
 * used the same "repeatedly take whatever's unblocked" approach). */
export function orderPackages(packages: TemplatePackage[]): TemplatePackage[] {
  const done = new Set<string>();
  const result: TemplatePackage[] = [];
  while (result.length < packages.length) {
    const before = result.length;
    for (const pkg of packages) {
      if (!done.has(pkg.name) && pkg.depends_on.every((dep) => done.has(dep))) {
        done.add(pkg.name);
        result.push(pkg);
      }
    }
    if (result.length === before) throw new Error("package dependency graph contains a cycle");
  }
  return result;
}

function validateManifest(value: ProjectTemplate): void {
  if (value.schema_version !== 2) throw new Error("unsupported schema_version (expected 2)");
  if (!value.template || !isSafeSlug(value.template.slug)) {
    throw new Error("template.slug must be a safe lowercase identifier");
  }
  if (!value.template.name?.trim() || !value.template.description?.trim()) {
    throw new Error("template name and description must not be empty");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > MAX_PACKAGES) {
    throw new Error(`packages must contain 1-${MAX_PACKAGES} entries`);
  }
  const names = new Set<string>();
  for (const pkg of value.packages) {
    if (!isSafeSlug(pkg.name)) throw new Error(`package \`${pkg.name}\` has an invalid name`);
    if (names.has(pkg.name)) throw new Error(`duplicate package name \`${pkg.name}\``);
    names.add(pkg.name);
    if (pkg.init_arg_base64 !== undefined && typeof pkg.init_arg_base64 !== "string") {
      throw new Error(`package \`${pkg.name}\` init_arg_base64 must be a string`);
    }
    decodeInitArg(pkg.name, pkg.init_arg_base64);
    if (pkg.prompt !== undefined && (typeof pkg.prompt !== "string" || pkg.prompt.length > 200)) {
      throw new Error(`package \`${pkg.name}\` prompt must be a string of at most 200 characters`);
    }
    if (!pkg.url || pkg.url.length > 2048 || !/^https?:\/\//.test(pkg.url)) {
      throw new Error(`package \`${pkg.name}\` has an invalid URL`);
    }
  }
  for (const pkg of value.packages) {
    for (const dep of pkg.depends_on) {
      if (dep === pkg.name || !names.has(dep)) {
        throw new Error(`package \`${pkg.name}\` has invalid dependency \`${dep}\``);
      }
    }
  }
  const byName = new Map(value.packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of value.packages) {
    if (!pkg.required) continue;
    for (const dep of pkg.depends_on) {
      if (!byName.get(dep)!.required) {
        throw new Error(`required package \`${pkg.name}\` depends on optional package \`${dep}\` - mark \`${dep}\` required or \`${pkg.name}\` optional`);
      }
    }
  }
  const placeholderRe = /\$\{([^}]+)\}/g;
  for (const [pkgName, fields] of Object.entries(value.config)) {
    const pkg = byName.get(pkgName);
    if (!pkg) throw new Error(`config references unknown package \`${pkgName}\``);
    for (const [fieldKey, literal] of Object.entries(fields)) {
      for (const raw of Array.isArray(literal) ? literal : [literal]) {
        if (typeof raw !== "string") continue;
        for (const match of raw.matchAll(placeholderRe)) {
          const token = match[1];
          const referenced = token.endsWith(".canister_id") ? token.slice(0, -".canister_id".length) : null;
          if (!referenced || !names.has(referenced)) {
            throw new Error(`config.${pkgName}.${fieldKey} references unknown placeholder \`\${${token}}\``);
          }
          if (!pkg.depends_on.includes(referenced)) {
            throw new Error(
              `config.${pkgName}.${fieldKey} references \${${token}} but \`${pkgName}\` does not depend_on \`${referenced}\` - add it so install order guarantees that canister id exists yet`,
            );
          }
        }
      }
    }
  }
  orderPackages(value.packages);
}

/** The packages that will actually be installed: every required package,
 * plus each optional one the user kept (`enabled[name] !== false`) whose
 * dependencies are all installed too - an optional package can't be
 * installed without what it depends on. Dependency-ordered. */
export function activePackages(packages: TemplatePackage[], enabled: Record<string, boolean>): TemplatePackage[] {
  const active = new Set<string>();
  for (const pkg of orderPackages(packages)) {
    if ((pkg.required || enabled[pkg.name] !== false) && pkg.depends_on.every((dep) => active.has(dep))) {
      active.add(pkg.name);
    }
  }
  return orderPackages(packages).filter((pkg) => active.has(pkg.name));
}

/** Substitutes every `${<package>.canister_id}` token in `raw` with that
 * package's real installed id. `validateManifest` already guarantees every
 * token refers to a package in the current one's own `depends_on`, so by
 * the time this runs (during the dependency-ordered install loop -
 * `pages/TemplateInstall.tsx`) the referenced id is always already in
 * `canisterIds`. */
function resolveCanisterIdReferences(raw: string, canisterIds: Record<string, string>): string {
  return raw.replace(/\$\{([^}]+)\}/g, (full, token: string) => {
    const referenced = token.endsWith(".canister_id") ? token.slice(0, -".canister_id".length) : null;
    const id = referenced ? canisterIds[referenced] : undefined;
    return id ?? full;
  });
}

async function readManifest(downloadUrl: string): Promise<ProjectTemplate> {
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Could not download canister_hub.toml: HTTP ${response.status}`);
  const value = parse(await response.text()) as unknown as ProjectTemplate;
  if (value.template) value.template.tags ??= [];
  value.packages = (value.packages ?? []).map((pkg) => ({
    ...pkg,
    required: pkg.required ?? true,
    depends_on: pkg.depends_on ?? [],
  }));
  value.config ??= {};
  validateManifest(value);
  return value;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const items = (await listMarketplaceItems()).filter((item) => isTemplateType(item.item_type));
  const results = await Promise.allSettled(items.map(async (item) => {
    const manifest = await readManifest(item.download_url);
    return {
      id: item.id.toString(),
      ...manifest.template,
      package_count: manifest.packages.length,
      icon_url: null,
      download_count: item.downloads,
      featured: item.downloads > 0n,
    };
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

export async function getTemplate(id: string): Promise<ProjectTemplate> {
  const item = await getMarketplaceItem(BigInt(id));
  if (!item || !isTemplateType(item.item_type)) throw new Error("Template not found");
  return readManifest(item.download_url);
}

/** Bumps the template marketplace item's own download counter - call once
 * when the user starts a deploy, same as `lib/deploy.ts` does per
 * marketplace item. */
export async function recordTemplateDownload(id: string): Promise<void> {
  await recordDownload(BigInt(id));
}

// ---------------------------------------------------------------------------
// Direct-from-the-browser package install - same management-canister call
// sequence as `lib/deploy.ts::deployMarketplaceItem`, minus the vetKD/
// purchase flow (a template's packages are plain public wasm URLs declared
// in the manifest, not gated marketplace items of their own).
// ---------------------------------------------------------------------------

async function managementActor(network: string): Promise<ManagementService> {
  const agent = await getAgent(network);
  return Actor.createActor<ManagementService>(managementIdlFactory, { agent, canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID) });
}

/** `null` if unset - see `lib/deploy.ts`'s identical helper for why this is
 * still a genuine, valid deploy either way. */
function orchestratorPrincipal(): Principal | null {
  const text = runtimeValue("ORCHESTRATOR_PRINCIPAL");
  return text ? Principal.fromText(text) : null;
}

export interface InstalledPackage {
  name: string;
  canisterId: string;
}

/** Downloads `pkg.url`'s wasm, creates a canister, installs it, sets
 * controllers to `[user, orchestrator]`, and records it on the project -
 * the package-level equivalent of `deployMarketplaceItem`. */
export async function installTemplatePackage(pkg: TemplatePackage, network: string, userPrincipal: Principal, projectId: string): Promise<InstalledPackage> {
  const isNotification = pkg.name.toLowerCase().replaceAll("-", "_") === "notification";
  if (isNotification) {
    const project = await getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    if (Object.values(project.canisters).some((info) => info.kind === "notification")) {
      throw new Error("This project already has a notification canister. Share it with the template modules instead of deploying another one.");
    }
  }
  const wasmResponse = await fetch(pkg.url);
  if (!wasmResponse.ok) throw new Error(`Could not download package \`${pkg.name}\`: HTTP ${wasmResponse.status}`);
  const wasm = new Uint8Array(await wasmResponse.arrayBuffer());
  const actor = await managementActor(network);

  const { canister_id: canisterId } =
    network === "local"
      ? await actor.provisional_create_canister_with_cycles({ amount: [], settings: [], specified_id: [], sender_canister_version: [] })
      : await actor.create_canister({ settings: [], sender_canister_version: [] });

  await actor.install_code({
    mode: { install: null },
    canister_id: canisterId,
    wasm_module: wasm,
    arg: decodeInitArg(pkg.name, pkg.init_arg_base64),
    sender_canister_version: [],
  });

  const orchestrator = orchestratorPrincipal();
  const controllers = orchestrator ? [userPrincipal, orchestrator] : [userPrincipal];
  await actor.update_settings({ canister_id: canisterId, settings: { controllers: [controllers] }, sender_canister_version: [] });

  if (isNotification) {
    await setModuleConfig(canisterId.toText(), network, {
      trusted_senders: { Vector: [{ PrincipalId: backendCanisterId() }] },
    });
  }

  const info: CanisterInfo = { id: canisterId.toText(), kind: isNotification ? "notification" : "other" };
  await addProjectCanisters(projectId, [[pkg.name, info]]);

  return { name: pkg.name, canisterId: canisterId.toText() };
}

// ---------------------------------------------------------------------------
// Config resolution - manifest literal defaults + a package's own schema
// defaults, with anything still required-and-unfilled left for the UI to
// prompt for.
// ---------------------------------------------------------------------------

type ScalarConfigType = ConfigVectorType | Exclude<ConfigType, { Vector: unknown }>;

function literalToScalarConfigValue(fieldType: ScalarConfigType, raw: string | number | boolean): ConfigValue | ConfigVectorValue | null {
  if ("Text" in fieldType || "TextArea" in fieldType || "SecretText" in fieldType || "Select" in fieldType) return { Text: String(raw) };
  if ("Number" in fieldType) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(n) ? { Number: BigInt(n) } : null;
  }
  if ("Float" in fieldType) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { Float: n } : null;
  }
  if ("Boolean" in fieldType) return { Boolean: Boolean(raw) };
  if ("CanisterPicker" in fieldType) {
    try {
      return { PrincipalId: Principal.fromText(String(raw).trim()) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Converts one manifest-declared literal into a real `ConfigValue`,
 * against the target field's own declared type - never guessed from the
 * literal's own shape. `null` means the literal didn't fit the field's
 * type, which the caller treats as "no usable default", not a hard error:
 * an author mistake here shouldn't block deploy, just fall through to
 * prompting the user instead. */
function literalToConfigValue(fieldType: ConfigType, raw: TemplateConfigLiteral): ConfigValue | null {
  if ("Vector" in fieldType) {
    if (!Array.isArray(raw)) return null;
    const values: ConfigVectorValue[] = [];
    for (const item of raw) {
      const converted = literalToScalarConfigValue(fieldType.Vector.element_type, item);
      if (!converted || "Vector" in converted) return null;
      values.push(converted);
    }
    return { Vector: values };
  }
  if (Array.isArray(raw)) return null;
  const converted = literalToScalarConfigValue(fieldType, raw);
  return converted && !("Vector" in converted) ? converted : null;
}

export interface PackageConfigPlan {
  /** Empty if the installed canister doesn't implement `ic::config` at all
   * - nothing to prompt or apply. */
  schema: ConfigFieldSchema[];
  /** Resolved values (manifest literal, else the schema's own default) -
   * ready to pass straight to `set_config`. */
  prefill: Record<string, ConfigValue>;
  /** Required fields with no resolved value yet - the UI must prompt for
   * these before `set_config` is called. */
  missingRequired: ConfigFieldSchema[];
}

/** `get_config_schema` rejects outright on a canister that never
 * implemented `ic::config` (an older or unrelated package) - treated the
 * same way `lib/moduleConfig.ts::hasModuleConfig` does: "no config here",
 * not an error to surface. */
async function tryGetConfigSchema(network: string, canisterId: string): Promise<ConfigFieldSchema[]> {
  try {
    return await getModuleConfigSchema(canisterId, network);
  } catch {
    return [];
  }
}

/** `canisterIds` must already contain every package this one `depends_on`
 * - true by construction when called in dependency order (see
 * `pages/TemplateInstall.tsx`'s deploy loop), and enforced ahead of time by
 * `validateManifest`'s `${x.canister_id}` -> `depends_on` cross-check. */
export async function getPackageConfigPlan(
  network: string,
  canisterId: string,
  pkg: TemplatePackage,
  manifest: ProjectTemplate,
  canisterIds: Record<string, string>,
  projectId: string,
): Promise<PackageConfigPlan> {
  const schema = await tryGetConfigSchema(network, canisterId);
  const literalDefaults = manifest.config[pkg.name] ?? {};
  const prefill: Record<string, ConfigValue> = {};
  const missingRequired: ConfigFieldSchema[] = [];

  for (const field of schema) {
    if (field.key === "project_id") {
      prefill[field.key] = { Text: projectId };
      continue;
    }
    const literal = literalDefaults[field.key];
    const resolved =
      typeof literal === "string"
        ? resolveCanisterIdReferences(literal, canisterIds)
        : Array.isArray(literal)
          ? literal.map((item) => (typeof item === "string" ? resolveCanisterIdReferences(item, canisterIds) : item))
          : literal;
    const fromManifest = resolved !== undefined ? literalToConfigValue(field.field_type, resolved) : null;
    if (fromManifest) {
      prefill[field.key] = fromManifest;
      continue;
    }
    const defaultValue = field.default_value[0];
    if (defaultValue !== undefined) {
      prefill[field.key] = defaultValue;
      continue;
    }
    if (field.is_required) missingRequired.push(field);
  }

  return { schema, prefill, missingRequired };
}

export async function applyPackageConfig(network: string, canisterId: string, values: Record<string, ConfigValue>): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await setModuleConfig(canisterId, network, values);
}
