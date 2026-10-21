import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";

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
    ["AUTH_NETWORK", network.managed ? "local" : "ic"],
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
    alias: { "@": "/src" },
  },
  ...(command === "serve" ? { server: getDevServerConfig() } : {}),
}));
