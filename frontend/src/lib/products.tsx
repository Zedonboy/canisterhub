import { PackageOpen } from "lucide-react";
import type { ReactElement } from "react";
import { listPackageInfos, type PackageInfo } from "./packageRegistry";

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
  packageInfo: PackageInfo;
  purchased: boolean;
}

function displayName(filename: string): string {
  return filename.replace(/\.wasm$/i, "").replaceAll("_", " ");
}

function adaptProduct(pkg: PackageInfo): Product {
  const color = "#00d4ff";
  const name = displayName(pkg.name);
  return {
    id: pkg.id,
    slug: name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "package",
    name,
    description: pkg.description,
    tagline: pkg.description,
    longDescription: pkg.description,
    icon: () => <PackageOpen size={16} />,
    iconUrl: null,
    color,
    bgColor: `${color}0d`,
    borderColor: `${color}33`,
    tag: "Free",
    cyclesPerDay: 0,
    cycleCost: "Free",
    popular: false,
    features: [
      "Installable WebAssembly release",
      `Version ${pkg.version}`,
      "SHA-256 verified package download",
    ],
    downloadCount: 0n,
    packageInfo: pkg,
    purchased: false,
  };
}

/** Package cards come from the controller-seeded package-info registry. */
export async function listProducts(): Promise<Product[]> {
  return (await listPackageInfos()).map(adaptProduct);
}

export async function getProduct(id: string): Promise<Product | null> {
  const pkg = (await listPackageInfos()).find((candidate) => candidate.id === id);
  return pkg ? adaptProduct(pkg) : null;
}
