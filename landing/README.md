# CanisterHub landing page

The public marketing site for CanisterHub - positioned for small and
growing businesses hosting their digital business and AI agents on the
Internet Computer. A static Vite + React + TypeScript SPA, styled with the
same design tokens as `frontend/` (see `src/index.css`) so the marketing
site and the dashboard read as one product.

This is **not** a canister of its own. Its build output
(`npm run build` → `dist/`) is embedded directly into the `backend`
canister's own Wasm at compile time and served as certified HTTP assets -
see `backend/src/lib.rs`'s "Landing page assets" section
(`LANDING_ASSETS`, `init_landing_assets`, `http_request`), built on the
`ic-asset-certification` + `include_dir` crates. Visiting `backend`'s own
canister URL serves this site directly; the signed-in dashboard
(`frontend/`) remains a separate canister entirely.

## Build order matters

`backend` embeds `landing/dist` at **Rust compile time**
(`include_dir!("$CARGO_MANIFEST_DIR/../landing/dist")`). That directory
must exist *before* `backend` is built - it is gitignored (same as
`frontend/dist`), so a fresh clone needs it built once:

```bash
cd landing
npm install
npm run build
```

Then build/deploy `backend` as usual. Forgetting this step means
`cargo build`/`icp build` for `backend` fails outright (the macro can't
embed a directory that doesn't exist), not a silent stale-content issue -
this is deliberate, so a missing landing build is never mistaken for an
unrelated backend compile error. Re-run `npm run build` here and rebuild
`backend` whenever the landing page's content changes; nothing watches or
regenerates it automatically.

## Developing

```bash
npm install
npm run dev      # live-reloading dev server, not connected to any canister
npm run build    # production build → dist/, what backend embeds
npm run preview  # serve the production build locally to sanity-check it
```

Nothing here calls a canister directly - no `@icp-sdk/core` agent, no
candid bindings, no identity. It's a pure static site; every "Get started"/
"Sign in" call to action is a placeholder pointing at the real dashboard's
URL once one exists for this deployment (there's no single fixed URL to
hardcode yet, since that depends on how this project is hosted/aliased).
