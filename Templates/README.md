# Project templates

Each direct child directory is a marketplace project template containing a
versioned `canister_hub.toml`. A template describes an application architecture;
it does not contain canister code. Packages remain independently versioned and
reusable.

Every `[[packages]]` entry has a required stable `name` and absolute HTTP(S)
`url`. The URL is the sole package locator; there is no separate source type.

Dependencies are deployed in topological order. Configure calls run only after
every package has a canister ID. Arguments and environment values may use
`${project.name}`, `${network}`, or `${package_name.canister_id}`. Manifests are
strictly parsed, bounded, and rejected for unknown fields, unsafe identifiers,
missing dependencies, or cycles.

The orchestrator exposes:

- `GET /marketplace/templates`
- `GET /marketplace/templates/:slug`
- `POST /marketplace/templates/:slug/deploy`

Set `TEMPLATES_DIR` to override the default `../Templates` catalog path.
