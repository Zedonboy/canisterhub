import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone app, same shape as `packages/table-browser`. Served by the
// `order_inventory` canister itself under `/admin/` (its Admin link),
// with the built `dist/` embedded into that canister's wasm at compile time
// (see `packages/order_inventory/src/assets.rs`).
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
});
