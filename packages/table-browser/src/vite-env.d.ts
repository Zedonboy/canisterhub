/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local-dev-only fallback for `lib/canisterId.ts::icSqlCanisterId` - the
   * served (non-dev) page gets this from a templated `<meta>` tag instead. */
  readonly VITE_IC_SQL_CANISTER_ID?: string;
  /** Local-dev-only fallback for `lib/canisterId.ts::network` - `"ic"` or
   * `"local"`. */
  readonly VITE_IC_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
