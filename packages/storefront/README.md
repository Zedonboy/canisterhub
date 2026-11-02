# storefront

A public, embeddable shop page for the `order_inventory` canister: customers
browse products and services, search / filter / sort, fill a cart, and place an
order. Browsing needs no account; **placing and viewing orders requires an
Internet Identity sign-in**. Light / dark / system theme (default: system).

Like `table-browser` and `inventory-browser`, it is not deployed on its own.
Its `dist/` is embedded into the `order_inventory` wasm (`include_dir!`) and
served from `http_request` at `/` (also aliased at `/shop`). `base: "./"`
keeps asset URLs relative.

```sh
cd packages/storefront
npm install
npm run build        # tsc -b && vite build
npm run dev:mock     # full UI against in-memory mock data, no canister needed
```

`packages/build.sh` builds it before compiling the embedding canister. Local
dev against a real canister: `.env.local` with
`VITE_INVENTORY_CANISTER_ID=<id>` and `VITE_IC_NETWORK=local|ic`.

The storefront header reads `storefront_business_name` and
`storefront_logo_url` from the serving canister's certified `ic_env` cookie.
If either setting is absent, it falls back to `get_business().name` and the
built-in store icon respectively.

## Routes (hash-based, so they work at any mount path and inside iframes)

`#/` shop · `#/item/<id>` item detail · `#/cart` cart + checkout ·
`#/orders` my orders (`#/orders?placed=<id>` shows the confirmation banner).

## Embedding

```html
<iframe id="shop" src="https://<canister>.icp0.io/?embed=1" style="width:100%;border:0"></iframe>
<script>
  addEventListener("message", (e) => {
    if (e.data?.type === "STOREFRONT_HEIGHT") shop.style.height = e.data.height + "px";
  });
</script>
```

`?embed=1` drops the footer and tightens padding; the page reports its height
so the host can size the frame (the message carries a number only). Notes:
- The canister's HTTP responses must not send `X-Frame-Options: DENY` /
  restrictive `frame-ancestors` for this page.
- Internet Identity opens in a popup, which works from a cross-origin iframe.
  The customer's II principal is per-origin, so a customer is one identity
  across every site that embeds *this canister's* page, but different from one
  who signed in on another origin.
- The cart is stored in `localStorage` (ids and quantities only; prices and
  stock always come from the canister at render/checkout time).

## Backend contract (implemented in `packages/order_inventory`)

The canister's older order path, `ai_place_order`, is gated to trusted agent
principals, so signed-in web customers use three direct methods instead (tests:
`storefront_*` in `order_inventory/tests/order_inventory_tests.rs`). The UI's
Candid mirror is `src/lib/candid/inventory.ts`; `list_inventory` (active items
only) and `get_business` are used as-is.

```candid
type AiChannel = variant { Email; WhatsApp; Telegram; Web };   // + Web
service : {
  place_order     : (PlaceOrder) -> (ResultOrder);       // non-anonymous caller
  list_my_orders  : () -> (ResultOrderList) query;       // non-anonymous caller
  cancel_my_order : (nat64) -> (ResultOrder);            // non-anonymous caller
}
```

- Derive the customer from the caller, never from the arguments:
  `CustomerIdentity { channel: Web, session_id: caller.to_text() }`, then call
  the same `place_order_inner` / `state::cancel_customer_order` that the
  `ai_*` methods use. Reject `Principal::anonymous()`.
- `list_my_orders`: filter orders by that `CustomerIdentity`, newest first.
- The storefront always sends `payment_method = CashOnDelivery` (prepaid needs
  a payment processor flow that has no UI yet) and a required delivery address,
  name and phone. Prices are never sent: the canister prices every line from
  its own inventory, which is what makes an untrusted browser safe here.
- `place_order` allows at most 5 open (pending / awaiting-payment) orders per
  customer, because stock is reserved on placement and a signed-in client could
  otherwise lock up inventory.
- `Web` customers share an identity scheme with `packages/chat-ui`
  (`session_id = principal`), so the agent's `ai_list_my_orders` for a customer's
  web chat session returns the same orders they placed here.
- Image URLs are the existing `image_url` field (uploaded via the storage
  canister by `inventory-browser`); the storefront just renders them.
