/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local-dev-only fallback for `lib/canisterId.ts::inventoryCanisterId`. */
  readonly VITE_INVENTORY_CANISTER_ID?: string;
  readonly VITE_IC_NETWORK?: string;
  /** `"1"` swaps every canister call for in-memory mock data (`lib/mock.ts`). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
