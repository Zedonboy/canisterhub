// Real marketplace item reads, directly from `backend` - no orchestrator
// HTTP call anywhere in this file. Re-exports bindgen's idiomatic
// `MarketplaceItem` shape as-is rather than adapting it again: both this
// file's own two callers (`InstallCanisterDialog`'s
// search dropdown and `lib/deploy.ts`'s deploy flow) need the real fields
// (`encrypted_key`, `git_repo_url`, `price`) directly, so there's nothing
// worth hiding behind a second representation.

import { backendCanisterId, getMarketplaceActor } from "./actors";
import { runtimeNetwork } from "./canisterEnv";
import { approveToken, formatTokenAmount, getTokenFee, ICP_LEDGER_CANISTER_ID } from "./wallet";
import type { MarketplaceItem } from "../bindings/backend";

export type { MarketplaceItem };

/** Marketplace prices are stored as raw ICP e8s, never floating point. */
export function formatMarketplacePrice(price: bigint): string {
  return `${formatTokenAmount(price, 8)} ICP`;
}

/** Every real marketplace item - the same catalog `search_marketplace`/
 * `deploy_marketplace_item` (the orchestrator's AI-driven tools) search over,
 * now also browsable directly from the dashboard. */
export async function listMarketplaceItems(): Promise<MarketplaceItem[]> {
  const actor = await getMarketplaceActor();
  return actor.list_marketplace_items();
}

/** One real marketplace item by id - `null` if it doesn't exist. Used by
 * the product detail page (`/project/:id/overview/product/:product_id`)
 * reached from a Marketplace card. */
export async function getMarketplaceItem(id: bigint): Promise<MarketplaceItem | null> {
  const actor = await getMarketplaceActor();
  return actor.get_marketplace_item(id);
}

/** Whether the current authenticated principal already has paid/download
 * access to an item. The backend derives the principal from the call; callers
 * cannot inspect purchase state for an arbitrary user. */
export async function hasPurchasedMarketplaceItem(id: bigint): Promise<boolean> {
  const actor = await getMarketplaceActor();
  const result = await actor.has_purchased_marketplace_item(id);
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok;
}

/** Loads ownership for paid items without making queries for free entries.
 * Individual lookup failures fail closed to showing the price. */
export async function purchasedMarketplaceItemIds(items: MarketplaceItem[]): Promise<Set<string>> {
  const paidItems = items.filter((item) => item.price !== undefined);
  const statuses = await Promise.all(
    paidItems.map(async (item) => {
      try {
        return [item.id.toString(), await hasPurchasedMarketplaceItem(item.id)] as const;
      } catch {
        return [item.id.toString(), false] as const;
      }
    }),
  );
  return new Set(statuses.filter(([, purchased]) => purchased).map(([id]) => id));
}

/** Completes the paid-item ICRC-2 flow before vetKD decryption:
 * 1. read the exact e8s price already present on the marketplace item;
 * 2. approve the backend for that price + the ledger's current transfer fee;
 * 3. ask the backend to `transfer_from` the buyer to the publisher and grant
 *    this caller `Read` access only after the ledger confirms payment.
 *
 * Free items need no payment. */
export async function purchaseMarketplaceAccess(item: MarketplaceItem): Promise<void> {
  if (item.price === undefined) return;

  const actor = await getMarketplaceActor();
  const purchaseStatus = await actor.has_purchased_marketplace_item(item.id);
  if ("Err" in purchaseStatus) throw new Error(purchaseStatus.Err);
  if (purchaseStatus.Ok) return;

  const network = runtimeNetwork();
  const ledgerId = ICP_LEDGER_CANISTER_ID;
  const transferFee = await getTokenFee(ledgerId, network);
  if (transferFee === null) {
    throw new Error("couldn't read the ICP ledger transfer fee needed for this purchase");
  }

  // ICRC-2 consumes both the transfer amount and transfer fee from the
  // allowance. The separate approval fee is charged directly to the buyer.
  await approveToken(
    ledgerId,
    network,
    backendCanisterId().toText(),
    item.price + transferFee
  );

  const purchaseResult = await actor.purchase_marketplace_item(item.id);
  if ("Err" in purchaseResult) throw new Error(purchaseResult.Err);
}

/** Best-effort popularity bump - a failure here should never block or
 * un-do an already-successful deploy. */
export async function recordDownload(id: bigint): Promise<void> {
  try {
    const actor = await getMarketplaceActor();
    await actor.record_download(id);
  } catch {
    // Best-effort, as above.
  }
}
