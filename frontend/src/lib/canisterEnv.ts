import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";

type RuntimeCanisterEnv = {
  readonly ["PUBLIC_CANISTER_ID:backend"]?: string;
  readonly AUTH_NETWORK?: string;
  readonly IC_HOST_LOCAL?: string;
  readonly IC_HOST_MAINNET?: string;
  readonly ORCHESTRATOR_URL?: string;
  readonly ORCHESTRATOR_PRINCIPAL?: string;
};

/** Runtime configuration stamped onto the frontend canister by icp-cli.
 * The `ic_env` cookie is supplied by the frontend canister in deployments
 * and simulated by Vite's dev server locally. */
export function canisterEnv(): (RuntimeCanisterEnv & { readonly IC_ROOT_KEY: Uint8Array }) | undefined {
  return safeGetCanisterEnv<RuntimeCanisterEnv>();
}

export function runtimeValue(name: keyof RuntimeCanisterEnv): string | undefined {
  const value = canisterEnv()?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function runtimeNetwork(): string {
  const configured = runtimeValue("AUTH_NETWORK");
  if (configured) return configured;

  // A frontend and its backend are deployed into the same icp-cli
  // environment. IC gateway domains therefore identify a mainnet build
  // without baking an environment choice into the Vite bundle.
  if (typeof window !== "undefined" && /(^|\.)(?:icp0|ic0|icp-api)\.io$/.test(window.location.hostname)) {
    return "ic";
  }
  return "local";
}

export function localIcHost(): string {
  return runtimeValue("IC_HOST_LOCAL") ?? "http://127.0.0.1:8000";
}

export function mainnetIcHost(): string {
  return runtimeValue("IC_HOST_MAINNET") ?? "https://ic0.app";
}
