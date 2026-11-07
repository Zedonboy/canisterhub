/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local-dev-only fallback for `lib/canisterId.ts::restaurantCanisterId` -
   * the served (non-dev) page gets its id from the `ic_env` cookie instead. */
  readonly VITE_RESTAURANT_CANISTER_ID?: string;
  /** Local-dev-only fallback for `lib/canisterId.ts::network` - `"ic"` or
   * `"local"`. */
  readonly VITE_IC_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
