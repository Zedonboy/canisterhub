import { parse } from "smol-toml";
import { MarketplaceItemType } from "../bindings/backend";
import { getBackendActor } from "./actors";
import { runtimeValue } from "./canisterEnv";
import { getMarketplaceItem, listMarketplaceItems, recordDownload } from "./marketplace";

const ORCHESTRATOR_URL = (runtimeValue("ORCHESTRATOR_URL") ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export interface TemplatePackage {
  name: string;
  url: string;
  required: boolean;
  depends_on: string[];
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

export interface ProjectTemplate {
  schema_version: number;
  template: Omit<TemplateSummary, "id" | "package_count" | "icon_url" | "download_count" | "featured">;
  packages: TemplatePackage[];
  configure: Array<{ target: string; method: string; args: string }>;
  environment: Record<string, string>;
}

function isTemplateType(itemType: MarketplaceItemType): boolean {
  return itemType === MarketplaceItemType.Template;
}

async function readManifest(downloadUrl: string): Promise<ProjectTemplate> {
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Could not download canister_hub.toml: HTTP ${response.status}`);
  const value = parse(await response.text()) as unknown as ProjectTemplate;
  if (value.schema_version !== 1 || !value.template || !Array.isArray(value.packages)) {
    throw new Error("Invalid template canister_hub.toml");
  }
  value.configure ??= [];
  value.environment ??= {};
  value.template.tags ??= [];
  value.packages = value.packages.map((pkg) => ({
    ...pkg,
    required: pkg.required ?? true,
    depends_on: pkg.depends_on ?? [],
  }));
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

async function readJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Orchestrator returned HTTP ${response.status}`);
  return value;
}

export async function deployTemplate(id: string, projectName: string, network: "local" | "ic"): Promise<string> {
  const actor = await getBackendActor();
  const tokenResult = await actor.issue_jwt();
  if ("Err" in tokenResult) throw new Error(tokenResult.Err);
  const response = await fetch(`${ORCHESTRATOR_URL}/marketplace/items/${encodeURIComponent(id)}/template/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenResult.Ok}` },
    body: JSON.stringify({ project_name: projectName, network }),
  });
  const value = await readJson(response);
  void recordDownload(BigInt(id));
  return value.job_id;
}
