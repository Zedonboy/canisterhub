# Kora Payment Provider

`kora-payment` implements the shared interface in `../payment_api.did`.
Inventory canisters call `create_charge`, passing their own canister ID as
`inventory_canister`; the response includes a hosted checkout URL. Kora stores
that target with the charge under its reference and uses the reference mapping
for the later `record_payment` call. Other regional provider packages should implement the same
request, response, and method name so inventory can switch providers by
changing its **Payment Processor Canister** setting.

Kora configuration is available through the package's dynamic settings:

- **Kora Secret Key**: the merchant secret key used by server-side HTTPS calls.
- **Trusted Canister List**: optional explicit callers for `create_charge`.
  Otherwise, the payment module asks the configured protocol canister to verify
  that both it and the calling inventory canister are packages in the project.

The redirect and webhook base URL is generated from this canister's ID as
`https://<canister-id>.icp0.io`. It appears as the read-only **IC HTTP Base
URL** value in dynamic settings so users can copy it into Kora's dashboard;
the package uses the generated URL automatically.

Prepaid orders need a customer email because Kora requires `customer.email`.
The customer is redirected to Kora's hosted checkout. Both Kora's redirect
and webhook are handled by this canister; neither is treated as proof of
payment. The package retrieves the charge from Kora and checks status,
reference, currency, and exact paid amount before calling the originating
inventory canister's `record_payment` method. Duplicate webhook or redirect
callbacks are safe because inventory records provider transactions
idempotently.

This package only implements hosted checkout. It never accepts card numbers,
CVV, PIN, or OTP data. Kora Checkout Redirect accepts whole major-currency
amounts; an order that cannot be represented exactly in that unit is rejected
instead of being rounded.

For a new provider package, preserve `payment_api.did` and replace the provider
adapter and callback implementation. Do not let provider-specific fields leak
into inventory's order API.
