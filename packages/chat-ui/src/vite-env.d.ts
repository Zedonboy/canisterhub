/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local-dev-only fallback for `lib/canisterId.ts::agentCanisterId`. */
  readonly VITE_AGENT_CANISTER_ID?: string;
  /** Local-dev-only fallback for `lib/canisterId.ts::network` - `"ic"` or `"local"`. */
  readonly VITE_MOCK?: string;
  readonly VITE_IC_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
