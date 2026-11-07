import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type NetworkStatus = {
  managed: boolean;
  api_url: string;
  gateway_url: string;
  root_key: string;
};

function icp(...args: string[]): string {
  return execFileSync("icp", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function getDevServerConfig() {
  const environment = process.env.ICP_ENVIRONMENT ?? "local";
  const network = JSON.parse(icp("network", "status", "-e", environment, "--json")) as NetworkStatus;
  const backendId = icp("canister", "status", "backend", "-e", environment, "--id-only");
  // Encode the complete cookie once. Encoding individual values first would
  // leave URLs such as `http%3A%2F%2F...` after the SDK decodes `ic_env`.
  const values = [
    ["PUBLIC_CANISTER_ID:backend", backendId],
    ["PUBLIC_AUTH_NETWORK", network.managed ? "local" : "ic"],
    ["IC_HOST_LOCAL", network.api_url],
    ["IC_HOST_MAINNET", "https://ic0.app"],
    ["ORCHESTRATOR_URL", "http://127.0.0.1:8787"],
    ["ic_root_key", network.root_key],
  ].map(([key, value]) => `${key}=${value}`).join("&");

  return {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(values)}; Path=/; SameSite=Lax`,
    },
    proxy: {
      "/api": { target: network.api_url, changeOrigin: true },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // Dependency installations can leave multiple physical copies of React
      // and React DOM. Without these aliases the bundler can pull one copy
      // for the app and another for a library (e.g.
      // @headlessui/react), after which hooks run against a null dispatcher
      // and every mount crashes with "Cannot read properties of null
      // (reading 'useId')". Pin every react* import at the root copy.
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)) },
      { find: /^react\/(.*)$/, replacement: `${fileURLToPath(new URL("./node_modules/react", import.meta.url))}/$1` },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("./node_modules/react-dom", import.meta.url)) },
      { find: /^react-dom\/(.*)$/, replacement: `${fileURLToPath(new URL("./node_modules/react-dom", import.meta.url))}/$1` },
      { find: "@", replacement: "/src" },
    ],
  },
  ...(command === "serve" ? { server: getDevServerConfig() } : {}),
}));
