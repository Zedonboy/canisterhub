# inventory-browser

The browser UI for the `order_inventory` canister: an SME manages its
**products and services** (price, optional stock tracking) and works its
**customer orders** (Pending -> Confirmed -> Preparing -> Ready -> Out for
delivery -> Completed, or Cancelled). Same shape as `packages/table-browser`
(Vite + React + Tailwind v4, no router).

- **Overview** - item counts, what needs restocking, open orders, completed sales.
- **Inventory** - search/filter, add/edit, activate/deactivate, stock adjustment.
- **Orders** - view every order (customer, items, delivery details) and move it
  through its statuses. Orders are placed by customers through the connected
  sales agent (`ai_place_order`), so there is no "new order" form here.
  Cancelling returns the order's stock, enforced by the canister.

There is no per-item reorder level in the canister, so "low stock" is one
UI-wide threshold (`LOW_STOCK_AT` in `src/lib/types.ts`).

## How it reaches the dashboard

`order_inventory` serves this app's built `dist/` itself under `/admin/`
(`packages/order_inventory/src/assets.rs`, embedded at compile time) and
declares `/admin/` as an `Admin` entry in `get_links`, so the dashboard's
"View data" action iframes it - exactly like `ic-sql` and `table-browser`.

The page learns its canister id from the `ic_env` cookie that canister sets
(`src/lib/canisterId.ts`). Every admin method on `order_inventory` is
controller-only, so identity matters:

1. **Embedded in the dashboard** - the page asks its parent for a delegation
   scoped to this one canister (`src/lib/parentDelegation.ts`; parent side:
   `frontend/src/lib/moduleDelegation.ts`) and acts as the signed-in
   dashboard user. No separate login.
2. **Standalone** - Internet Identity sign-in (`src/lib/auth.ts`).
   **Staying signed in:** the delegation lasts 1 hour (the dashboard decides),
   so the page renews it at 75% of its lifetime by repeating the same request
   (`src/lib/parentDelegation.ts`). Calls that still get rejected as expired
   (a laptop that slept through the timer) renew once and retry
   (`src/lib/session.ts`). If the dashboard stops delegating - its own
   session ended - the page keeps working until the last delegation expires,
   then shows "Your dashboard session has ended", checks again every 30
   seconds, and recovers by itself once the user is signed in on the
   dashboard again.
3. Anonymous or a non-controller - the page shows an "only controllers" notice.

## Product / service images

Each item can have a picture. The file is uploaded straight from the browser
to a **separate asset-storage canister** with `AssetManager` (from
`@icp-sdk/canisters/assets`, the class the dashboard's Storage page uses),
and the resulting public URL is **saved on the item** as `image_url` on
`order_inventory`. The table and form simply show `item.imageUrl`; nothing
looks files up on the storage canister afterwards. Replacing or removing a
picture also deletes the old file (best effort). PNG/JPG/WebP etc., up to 5 MB;
`order_inventory` only accepts `http(s)://` URLs.

- **Finding the storage canister** (`src/lib/storageCanister.ts`), in order:
  1. The runtime canister environment: `storage_canister_id` in the `ic_env`
     cookie (`PUBLIC_CANISTER_ID:storage` also works).
     `order_inventory` copies its `storage_canister_id` environment variable
     into that cookie - set it with
     `icp canister settings update order_inventory --set-environment-variable storage_canister_id=<id>`
     and redeploy/upgrade (the cookie is certified content, rebuilt only on
     install/upgrade).
  2. The canister's own **Storage Canister** setting (`get_config`, key
     `storage_canister`), a canister picker in the dashboard's canister
     Settings page. This is the dependable one: browsers drop the cookie when
     the page is embedded cross-site in the dashboard, while this is a plain
     public query.
  With neither, the image controls are hidden and the page says so.
- **Permissions:** the signed-in user needs **Commit** permission on the
  storage canister, same as uploading from the dashboard's Storage page.
- **Dashboard tunnel:** a delegation is scoped to specific canisters, so the
  page also asks its parent to include the storage canister
  (`additionalCanisterIds` in `src/lib/parentDelegation.ts`). The dashboard
  (`frontend/src/pages/CanisterViewData.tsx`) only grants ids that are one of
  the project's own storage canisters; without it the replica rejects uploads.
- **Classic asset canister only:** `AssetManager` speaks `list`/`store`/
  `create_batch`. The newer icp-cli `static-site` canister has a different
  interface (`get_asset_details`, `execute_operations`) and won't work.
- **Local URLs** use the page's own gateway port, so open the app through the
  gateway (`<id>.localhost:8000`), not a different dev port, if you want saved
  URLs to keep working.

## Build order

`order_inventory` embeds `dist/` at *compile* time, so build this first
(`packages/build.sh` does it for you):

```sh
cd packages/inventory-browser
npm install
npm run build
cd .. && cargo build -p order_inventory --target wasm32-unknown-unknown --release
```

Cargo does not notice `dist/` changes by itself - after rebuilding the UI,
`touch packages/order_inventory/src/assets.rs` before the Cargo build, or the
old UI stays in the wasm.

## Local development

`npm run dev` has no canister serving it, so name one in `.env.local`:

```sh
# packages/inventory-browser/.env.local
VITE_INVENTORY_CANISTER_ID=<a deployed order_inventory canister id>
VITE_IC_NETWORK=local   # or "ic"
```

Then sign in with an identity that controls that canister.

## Code map

- `src/lib/candid/orderInventory.ts` - hand-written mirror of `order_inventory.did` (only the admin methods this UI calls).
- `src/lib/api.ts` - the one place that calls the canister; flattens candid opts/variants/nat64s into `src/lib/types.ts`.
- `src/lib/format.ts` - prices are integer minor units; digits come from the currency via `Intl`.
