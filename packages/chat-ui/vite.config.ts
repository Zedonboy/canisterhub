import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Two HTML entry points, one build:
//   index.html - the SME inbox (all channels + agent console), meant to be
//                iframed into the dashboard like `table-browser`
//   chat.html  - the anonymous customer-facing "web channel" page
// `base: "./"` keeps asset URLs relative so the agent canister can serve
// the two pages at whatever paths it likes (e.g. `/inbox`, `/chat`) -
// see README.md.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  build: {
    rollupOptions: {
      input: {
        inbox: resolve(__dirname, "index.html"),
        chat: resolve(__dirname, "chat.html"),
      },
    },
  },
});
