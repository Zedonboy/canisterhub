import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Single-entry admin app, served by the embedding payment canister (e.g.
// `kora-payment`) under `/admin/` - so the build's asset URLs must be
// rooted there too (same `base` choice `table-browser` makes for `ic-sql`).
// The canister reads `dist/` into its wasm with `include_dir!` at compile
// time; there is no deploy-time asset upload step (see README.md).
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
});
