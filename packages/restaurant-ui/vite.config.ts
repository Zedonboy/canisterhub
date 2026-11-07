import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Duplicated from inventory-browser and adapted for the restaurant package.
// The canister serves the public storefront at `/` and this same SPA renders
// its controller manager at `/admin/`, so assets use a root base path.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
});
