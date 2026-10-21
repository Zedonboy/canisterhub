import { LockKeyhole, PackageOpen } from "lucide-react";
import type { ReactElement } from "react";
import { MarketplaceItemType } from "../bindings/backend";
import { formatMarketplacePrice, getMarketplaceItem, hasPurchasedMarketplaceItem, listMarketplaceItems, purchasedMarketplaceItemIds, type MarketplaceItem } from "./marketplace";

/** Presentation-only view of a real marketplace item. The backend has no
 * separate product catalog: MarketplaceItem is the sole persisted model. */
export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  tagline: string;
  longDescription: string;
  icon: () => ReactElement;
  iconUrl: null;
  color: string;
  bgColor: string;
  borderColor: string;
  tag: "Free" | "Paid";
  cyclesPerDay: 0;
  cycleCost: string;
  popular: boolean;
  features: string[];
  downloadCount: bigint;
  item: MarketplaceItem;
  purchased: boolean;
}

function displayPrice(price: bigint | undefined): string {
  if (price === undefined) return "Free";
  return formatMarketplacePrice(price);
}

function adaptProduct(item: MarketplaceItem, purchased = false): Product {
  const paid = item.price !== undefined;
  const color = paid && !purchased ? "#ffab40" : "#00d4ff";
  const Icon = paid ? LockKeyhole : PackageOpen;
  return {
    id: item.id.toString(),
    slug: item.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item",
    name: item.title,
    description: item.description,
    tagline: item.description,
    longDescription: item.description,
    icon: () => <Icon size={16} />,
    iconUrl: null,
    color,
    bgColor: `${color}0d`,
    borderColor: `${color}33`,
    tag: paid ? "Paid" : "Free",
    cyclesPerDay: 0,
    cycleCost: purchased ? "Download" : displayPrice(item.price),
    popular: item.downloads > 0n,
    features: [
      "Installable WebAssembly release",
      "Publisher repository verified",
      paid ? "ICP payment with vetKD-protected download" : "Free public download",
    ],
    downloadCount: item.downloads,
    item,
    purchased,
  };
}

/** Marketplace items are products. This adapter only supplies visual fields
 * expected by the existing cards; it does not create another data model in
 * the backend. */
export async function listProducts(): Promise<Product[]> {
  const items = (await listMarketplaceItems()).filter(
    (item) => item.item_type === MarketplaceItemType.Package,
  );
  const purchasedIds = await purchasedMarketplaceItemIds(items);
  return items.map((item) => adaptProduct(item, purchasedIds.has(item.id.toString())));
}

export async function getProduct(id: string): Promise<Product | null> {
  let itemId: bigint;
  try {
    itemId = BigInt(id);
  } catch {
    return null;
  }
  const item = await getMarketplaceItem(itemId);
  if (item === null || item.item_type !== MarketplaceItemType.Package) return null;
  const purchased = item.price === undefined ? false : await hasPurchasedMarketplaceItem(item.id);
  return adaptProduct(item, purchased);
}
