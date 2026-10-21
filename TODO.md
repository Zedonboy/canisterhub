# TODO

## Re-enable AI (Secretary) and Marketplace — when funds allow

Disabled for the production launch. Search the frontend for `disabled for production launch` / `Ask AI disabled` to find every spot.

- [ ] `frontend/src/App.tsx`: uncomment lazy imports (`Marketplace`, `MarketplaceItemDetail`, `Orchestrate`) and routes (`/marketplace`, `/market/product/:id`, `/market/publisher`, `overview/product/:product_id`); replace the `orchestrate` -> `../overview` redirect with `<Orchestrate />`.
- [ ] `components/layout/TopNav.tsx`: Marketplace tabs (desktop + mobile) and `<ProductSearch compact />`.
- [ ] `components/layout/Sidebar.tsx`: Secretary nav item.
- [ ] `components/CommandPalette.tsx`: Secretary + Marketplace entries.
- [ ] `pages/Dashboard.tsx`: "describe what you want" prompt box and "Browse the full Marketplace" link.
- [ ] "Ask AI to Add …" buttons: `pages/Storage.tsx`, `Auth.tsx`, `Database.tsx`, `Analytics.tsx`, `Agents.tsx` (agents + connectors).
- [ ] Remove the "Coming soon" pill from those same empty states, and restore the "Browse Market" buttons in empty states (Storage, Auth, Database, Analytics, Agents x2) and Overview "Create & Deploy a Canister" button — these opened `InstallCanisterDialog` (marketplace search + "Create Custom Canister with AI"), which is now unreachable. `InstallProductDialog` is only used by the disabled `ProductInstall` route.
- [ ] Deploy the orchestrator with a funded LLM provider (`LLM_PROVIDER`), then `icp deploy frontend`.
