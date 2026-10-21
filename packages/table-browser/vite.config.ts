import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone app - no monorepo-wide dev-server plumbing to plug into (see
// README.md's "Local development" section for why this doesn't shell out
// to `icp` the way `frontend/vite.config.ts` does: this app always talks
// to exactly one `ic-sql` canister, resolved from `VITE_IC_SQL_CANISTER_ID`/
// `VITE_IC_NETWORK` here, or from the server-injected `<meta>` tag once
// actually served by that canister - see `src/lib/canisterId.ts`).
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
});
