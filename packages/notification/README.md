# Notification module

A project-owned Web Push canister. It stores browser subscriptions in stable
memory, encrypts payloads using RFC 8291, signs requests with VAPID (RFC 8292),
and delivers them directly to push-service HTTPS endpoints.

Initialize its VAPID identity once after installation:

```sh
icp canister call notification push_init_vapid '("mailto:ops@example.com")'
```

Configure `Trusted Senders` in the CanisterHub module settings to allow an
agent or business module to call `push_send`. Controllers are always allowed.
Browser subscription methods remain caller-scoped: a caller can only list or
remove subscriptions stored under its own principal.

The VAPID private scalar never leaves the API, but canister memory is not an
HSM and may be visible to subnet node operators.

