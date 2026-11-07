# Paystack Payment Provider

`paystack-payment` implements the shared interface in `../payment_api.did`.
Inventory canisters call `create_charge`, passing their own canister ID as
`inventory_canister`; the package initializes a Paystack transaction and
returns the hosted authorization URL. The package stores the inventory canister
and order against the transaction reference for later payment recording.

Configure **Paystack Secret Key** in the package's dynamic settings. The
optional **Webhook Signing Secret** accepts Paystack's `whsec_...` signing
secret for timestamped `Paystack-Signature` webhook validation. Legacy
`x-paystack-signature` webhooks are checked against the API secret key.
The optional **Trusted Canister List** explicitly permits callers to
`create_charge`; callers not listed there must be verified by the protocol as
packages in the same project as this payment module.

The read-only **IC HTTP Base URL** is generated from this canister ID. Set the
Paystack dashboard webhook URL to `https://<canister-id>.icp0.io/webhook/paystack`;
the package supplies `https://<canister-id>.icp0.io/checkout/return` as the
transaction callback URL automatically.

Redirects and authenticated webhooks are both followed by a server-side
Paystack transaction verification call. The module checks the stored
transaction reference, successful transaction status, currency, and exact
amount in the currency's minor denomination before calling the originating
inventory canister's `record_payment`. Inventory is responsible for
idempotent payment recording and its customer receipt flow. Successful
payments also trigger the configured project-owner web push notification.

This package never accepts card numbers, CVV, PIN, or OTP data. Paystack's
hosted checkout handles the payment form.
