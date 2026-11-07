# restaurant-ui

Restaurant management and public food ordering UI, duplicated from
`packages/inventory-browser` and adapted for restaurant menus. The manager
uses the inventory app's table, search, filter, and add-item form patterns;
menu entries are products only and price portions plus one automatically
charged plate per ordered dish line.

The public storefront is served by the `restaurant` canister at `/`. The
controller-only manager is served by the same embedded SPA at `/admin/`.
Public checkout uses the canister's menu pricing and payment settings, then
polls the web order using a browser-generated session token. Prepaid orders
link to the configured payment package.

## Develop

```sh
npm install
npm run dev
```

Set the local canister and network in `.env.local`:

```sh
VITE_IC_NETWORK=local
VITE_RESTAURANT_CANISTER_ID=<local restaurant canister id>
```

## Build

```sh
npm run build
```

The `packages/build.sh` workspace build runs this before compiling the
restaurant canister, which embeds `dist/` into `restaurant.wasm`.
