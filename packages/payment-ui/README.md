# payment-ui

The embedded admin UI for a CanisterHub payment module canister (canonical
implementation: `packages/kora-payment`), built as one small Vite app:

| Entry | Built file | Who | What |
|---|---|---|---|
| `index.html` | `dist/index.html` | the merchant/SME (dashboard iframe, like `table-browser`) | **Transactions** - the canister's full charge log (amount, status, Kora reference, provider transaction id, owner-notified flag) with search + polling - and **Settings**, the module's own dynamic config (`get_config_schema`/`set_config`) |

Like `table-browser`, it is not deployed on its own. Its `dist/` is embedded
into the payment canister's wasm (`include_dir!`) and served certified at
`/admin/`, declared to the dashboard through `#[config_links(("Transactions",
"/admin/", Admin))]` on the canister's config - so the canister card's
"View data" action iframes it with the dashboard's identity delegated in,
exactly like `ic-sql`'s table browser.

```sh
cd packages/payment-ui
npm install
npm run build        # tsc -b && vite build
```

`packages/build.sh` builds it before compiling the embedding canister, and
`kora-payment`'s Rust tests assume `dist/` already exists.

## Backend contract (implemented in `packages/kora-payment`)

- `list_transactions() -> Result<Vec<Transaction>, String>` - controller-only
  query; the full charge log, newest first. `Transaction` carries the
  verification status (`Pending`/`Paid`/`Failed`) the canister last
  recorded, plus the provider's own transaction id once paid.
- `get_config_schema` / `get_config` / `set_config` - the standardized
  dynamic-config surface (`canister-hub-sdk::ic::config`); `set_config` is
  controller-only and a partial merge. Secret fields come back masked from
  `get_config` for non-controllers.
- `canister_metadata` / `get_links` - self-declared identity and pages.

## Identity

Same scheme as `table-browser` - dashboard delegation when iframed
(`lib/parentDelegation.ts`, protocol in `frontend/src/lib/moduleDelegation.ts`),
else Internet Identity sign-in. Everything on the page is controller-gated
on the canister side, so anonymous visitors only see the sign-in gate.

## Local development

`.env.local` with `VITE_PAYMENT_CANISTER_ID=<id>` and `VITE_IC_NETWORK=local|ic`,
then `npm run dev`. The canister id resolves from the `ic_env` cookie the
serving canister stamps on every response (see
`packages/kora-payment/src/assets.rs::ic_env_cookie`) when there is one;
the env vars stand in for the Vite dev server (see `src/lib/canisterId.ts`).
