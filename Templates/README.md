# Project templates

Each direct child directory is a marketplace project template containing a
versioned `canister_hub.toml`. A template describes an application architecture;
it does not contain canister code. Packages remain independently versioned and
reusable.

Every `[[packages]]` entry has a required stable `name` and absolute HTTP(S)
`url`. The URL is the sole package locator; there is no separate source type.

An optional package (`required = false`) may set `prompt`, the question shown
beside its install checkbox (e.g. `prompt = "Add an online storefront?"`); the
package name is shown when it is omitted.

A package may set `init_arg_base64`: the base64 of its already-encoded Candid
install argument (bytes starting `DIDL`, e.g. from `didc encode`). It is
passed to `install_code` as-is; omit it for the empty argument `()`. An
invalid value is rejected when the manifest loads, before any canister is
created. Candid text may be accepted as an alternative later.

```toml
[[packages]]
name = "inventory"
url = "https://marketplace.candid.cloud/packages/order-inventory"
init_arg_base64 = "RElETAAA"   # `()`, shown only to illustrate the format
```

Deploying a template is entirely client-side (`frontend/src/lib/templates.ts`,
driven by `pages/TemplateInstall.tsx`) - there is no orchestrator endpoint for
this at all. The browser downloads+validates the manifest itself, installs
each package directly via the management canister in dependency order (same
direct-install pattern `lib/deploy.ts` uses for a single marketplace item),
then configures each one through its own `ic::config` surface
(`get_config_schema`/`set_config` - see `sdk/src/ic/config.rs`) rather than
through a separate candid-call mechanism: a package's own schema already
gives every field a type, a default, and a required/optional flag.

`[config.<package_name>]` supplies literal overrides for that package's own
config fields, applied before anything still required-and-unfilled gets
prompted for in the UI. A string value may reference another package's real
installed canister id with `${<package_name>.canister_id}` - valid only when
`<package_name>` appears in this package's own `depends_on` (that's what
guarantees the referenced id already exists by the time it's resolved; a
reference to a package not depended on is rejected at validation time, not
left to fail at deploy time). There is no build-time env-var injection
mechanism (the old `[environment]` section, removed in schema_version 2) -
a package needing another package's id at runtime should declare its own
`ic::config` field for it, resolved the same `${x.canister_id}` way, rather
than expecting a value baked into its wasm before upload (the browser has no
compiler to rebuild a package's wasm with substituted values; a package's
own code is fixed by the time its `url` is reachable).

Manifests are strictly validated client-side: unsafe identifiers, missing or
cyclic dependencies, unknown config-package references, and malformed
`${...}` placeholders are all rejected before any canister is touched.

Known gap: the `spreadsheet_ui`/`storefront` packages these example
manifests declare (`silver-spreadsheet-ui`, `food-order-ui`,
`laundry-order-ui`) don't exist anywhere yet - these templates are
architecture examples, not currently fully deployable end-to-end.
