# table-browser

A standalone Supabase-style table browser (list tables, browse/filter/edit/
insert/delete rows) for one `ic-sql` canister. Not deployed on its own: its
built `dist/` is embedded directly into `ic-sql`'s own wasm at compile time
(see `packages/ic-sql/src/assets.rs`) and served by that canister's own
`http_request`/`http_request_update`, alongside its existing `/rest/v1/*`
PostgREST gateway (see `packages/ic-sql/src/http.rs`).

Ported from the main dashboard's `frontend/src/pages/DatabaseTable.tsx` +
`frontend/src/lib/database.ts`, trimmed to one fixed canister - this app
has no "project"/multi-canister concept at all, since it's always served
by, and always talks to, exactly the one `ic-sql` canister embedding it.

## Build order

`ic-sql`'s own Rust build embeds this app's `dist/` via `include_dir!` at
*compile* time, so this app must be built **before** `ic-sql` on every
build:

```sh
cd packages/table-browser
npm install
npm run build

cd ../ic-sql   # or: cd .. && ./build.sh (already does this step for you)
cargo build --target wasm32-unknown-unknown --release
```

`packages/build.sh` runs `npm install`/`npm run build` here automatically
before the Cargo build - you only need the manual steps above when
iterating on this app alone without re-running the whole workspace script.

## Local development

`npm run dev` runs a normal Vite dev server against mock-free, real
canister calls - but since there's no served page to read a canister id
from, you need a `.env.local` naming one explicitly:

```sh
# packages/table-browser/.env.local
VITE_IC_SQL_CANISTER_ID=<a real, already-deployed ic-sql canister id>
VITE_IC_NETWORK=local   # or "ic" for mainnet
```

See `src/lib/canisterId.ts` for exactly how this is resolved (and how the
real served page gets its canister id instead - via the real `ic_env`
cookie `@icp-sdk/core/agent/canister-env` defines, the same mechanism
`frontend/`'s own `lib/canisterEnv.ts` reads, which `ic-sql` itself stamps
on every response - no env var or page templating needed there).
