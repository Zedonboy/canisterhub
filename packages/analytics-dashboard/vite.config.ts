import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone app, moved out of `frontend/src/pages/Analytics.tsx` (see
// that app's own `pages/Analytics.tsx`, now a canister-listing page
// instead - this is where its former dashboard content landed). Unlike
// `table-browser`, this one isn't embedded into any canister's own wasm
// (there's no real analytics-canister candid interface wired up here -
// every chart is still the same illustrative `lib/mock-data.ts` sample
// data it always was) - just a standalone page to run on its own.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
});
