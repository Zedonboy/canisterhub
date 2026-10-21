import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Pure static marketing site - no dev-server proxy/cookie injection like
// frontend/vite.config.ts needs (nothing here ever calls a canister
// directly). `build` output is what backend/src/lib.rs embeds via
// `include_dir!("$CARGO_MANIFEST_DIR/../landing/dist")` and serves with
// `ic-asset-certification` - see that file's "Landing page assets" section.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
  build: {
    // Keeps asset filenames predictable to glob against in the backend's
    // AssetConfig::Pattern entries (`assets/*.js`, `assets/*.css`) - Vite's
    // default `assets/` output directory already matches, this just makes
    // that explicit rather than incidental.
    assetsDir: "assets",
  },
});
