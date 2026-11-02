# Order inventory

An upgrade-safe, single-business canister for products, services, stock, and customer orders.

The same canister serves its certified inventory admin UI at `/admin/` and
its certified public storefront at `/` (with `/shop` as an alias).

Controllers are the SME administrators. Before connecting an agent, trust its canister principal and optionally grant specific channel sessions staff privileges:

```sh
icp canister call order_inventory set_trusted_agent '(principal "<agent-id>", true)'
icp canister call order_inventory set_staff '(record { channel = variant { WhatsApp }; session_id = "+234..." }, true)'
icp canister call agent add_canister '(principal "<order-inventory-id>")'
```

Customer AI methods use `AiContext` supplied by the calling agent, so customers cannot select another customer's identity in JSON. Staff-only AI methods additionally require the conversation identity to be explicitly registered by a controller.

Money is stored as integer minor units (for example, 2500 means 25.00 in a two-decimal currency). Stock is reserved atomically when an order is placed and restored if it is cancelled or an unpaid reservation expires. Products and services may leave `stock_quantity` unset to disable stock tracking.

Orders support `CashOnDelivery` and `Prepaid`. Prepaid orders remain
`AwaitingPayment` until a controller or trusted payment-processor principal
confirms the exact amount and currency. Cash-on-delivery orders cannot become
`Completed` until collection is recorded. Provider payment, refund, and cash
receipt identifiers are idempotent. Paid cancellations become
`RefundPending`; partial and full refunds are tracked separately.

Unpaid prepaid reservations have a configurable TTL (30 minutes by default).
Call `expire_unpaid_orders` periodically to mark them `Expired` and release
their stock. Order placement, payment, failure, status changes, expiry,
collection, cancellation, and refunds write append-only stable audit entries.
Controllers read them with `list_audit`; authorized staff can use
`ai_list_order_audit`.

Every order requires a non-empty delivery address. GPS latitude and longitude are optional, but when supplied they must be provided together.

The dashboard's dynamic configuration exposes an editable, typed `Storage Canister ID` picker and a foldable `Storefront Branding` section for the public business name and logo URL. Once changed, the canister immediately rebuilds its certified asset responses. It includes the selected principal as `storage_canister_id`, plus branding as `storefront_business_name` and `storefront_logo_url`, in the embedded HTML's `ic_env` cookie.

The `Custom Domains` settings section accepts one hostname per line. The
canister trims, lowercases, and de-duplicates those entries, then publishes
them as a certified text response at `/.well-known/ic-domains`. Updating the
setting rebuilds the certification tree immediately; DNS configuration and
registration with the IC custom-domain service are still separate steps.
