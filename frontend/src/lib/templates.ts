import packageSeed from "../../../scripts/package-seed.json";
import { MarketplaceItemType, type MarketplaceItem } from "../bindings/backend";
import { getMarketplaceActor } from "./actors";

export type Template = MarketplaceItem;

const seededTemplateKeys = new Set(
  packageSeed.templates.map((template) => `${template.git_repo_url.replace(/\/+$/, "").toLowerCase()}|${template.package_slug}`),
);

function isSeededTemplate(item: MarketplaceItem): boolean {
  return item.item_type === MarketplaceItemType.Template
    && seededTemplateKeys.has(`${item.git_repo_url.replace(/\/+$/, "").toLowerCase()}|${item.package_slug}`);
}

/** Returns only official template records represented in package-seed.json. */
export async function listTemplates(): Promise<Template[]> {
  const actor = await getMarketplaceActor();
  return (await actor.list_marketplace_items()).filter(isSeededTemplate);
}

export async function getTemplate(id: bigint): Promise<Template | null> {
  const actor = await getMarketplaceActor();
  const item = await actor.get_marketplace_item(id);
  return item && isSeededTemplate(item) ? item : null;
}
