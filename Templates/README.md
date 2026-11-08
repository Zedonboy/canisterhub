# Project template drafts

The current drafts are:

- `food-order-service/canister_hub.toml` — AI Food Ordering
- `ai-inventory-ordering/canister_hub.toml` — AI Inventory Ordering

Both use the existing schema-version-2 TOML manifest format. Their package
URLs point at the versioned R2 artifacts in `scripts/package-seed.json`.
Package install order is storage, business canister, then agent. Manifest
config references connect the storage and business canisters and register the
business canister as an AI tool for the agent.

The agent prompts are defaults that the project owner can edit. The templates
do not include provider credentials or payment configuration. After package
installation, the owner can configure those values in each package's settings;
payment-provider choice remains with the vendor.

These files are drafts only and are not seeded to the backend marketplace.
Older manifests in sibling directories are legacy examples and are not part
of the two current template drafts.
