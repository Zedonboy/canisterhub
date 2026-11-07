# Marketplace scripts

Node/ESM helper scripts around the `backend` canister's vetKD-backed
marketplace flow. See `backend/src/lib.rs` and the `vetkd` skill for the
underlying model: https://skills.internetcomputer.org/.well-known/skills/vetkd/SKILL.md

The scripts do not maintain a handwritten Candid interface. Generate the
backend declaration from `backend/backend.did` with:

```bash
npm run generate
```

## Production package releases

`seed_package_infos.js` uploads the current package release registry used to
detect upgrades on installed project canisters. Validate the checked-in
v1.0.0 release data without changing canister state:

```bash
cd scripts
npm run seed-packages -- --file ./production-packages.v1.0.0.json --dry-run
```

Seed a local backend (the default environment) - run after `icp deploy
backend` so a fresh local network carries the same production registry the
dashboard's upgrade detection expects:

```bash
npm run seed-packages -- --file ./production-packages.v1.0.0.json
```

Seed the production backend with a controller identity:

```bash
npm run seed-packages -- \
  --file ./production-packages.v1.0.0.json \
  --environment ic \
  --identity deploy
```

Each seed row's `package_name` is the HTTPS GitHub Release URL for its `.wasm`
artifact. The script maps that field to the backend's `url` field. The backend
automatically sets each package name from the final `.wasm` filename, such as
`agent.wasm`; seed files do not include a separate `name`. Modules use that stable artifact name as their dynamic configuration
dependency ID. The seed file also does not choose the backend's
internal package ID: on first upload the backend assigns
`<hyphenated-name>-<raw_rand hex>` and retains it for later releases of the
same artifact. The backend also retains the
version and SHA installed on each project canister, so a new registry SHA
appears as an explicit dashboard upgrade instead of silently changing
installation history.

`npm run publish` regenerates that declaration before running
`publish_to_marketplace.js`. The generated `bindings/` directory is ignored;
`backend.did` remains the interface source of truth.

## Catalog uploader (controller)

Use `upload_marketplace_catalog.js` to seed or update several official
templates and free packages in one run. It signs through the installed `icp`
CLI, so the selected identity must be a controller of `backend`; the script
never reads or stores the controller's private key.

Copy [`catalog.example.json`](./catalog.example.json), update its GitHub
release URLs and local file paths, then validate it without changing state:

```bash
cd scripts
npm run upload-catalog -- --file ./catalog.json --dry-run
```

Upload to the local backend with the current default identity:

```bash
npm run upload-catalog -- --file ./catalog.json
```

Upload to mainnet with a named controller identity:

```bash
npm run upload-catalog -- \
  --file ./catalog.json \
  --environment ic \
  --identity deploy
```

The script resolves `manifest_file` and `wasm_file` relative to the catalog,
checks that every referenced file exists, and hashes all files before its
first canister update. Templates use `add_marketplace_template`; packages are
registered to the same controller principal and then use
`publish_marketplace_item`. Repository/slug pairs are upserts, so rerunning a
catalog updates listings rather than duplicating them.

This bulk path intentionally supports only free packages. Continue using
`publish_to_marketplace.js` (or the versioned GitHub Action below) for paid
packages because that path generates an AES key, encrypts the Wasm, and wraps
the key with vetKD before publishing.

## Versioned GitHub Action

Third-party repositories do not need to copy these scripts. Use the action
published from this repository:

```yaml
permissions:
  id-token: write       # required - lets the action attest build provenance (below)
  attestations: write   # required - lets it publish that attestation to this repo

steps:
  - uses: Zedonboy/canister_hub/publish_to_market@v1
    with:
      backend-canister-id: ${{ vars.MARKETPLACE_CANISTER_ID }}
      publisher-identity-seed: ${{ secrets.PUBLISHER_IDENTITY_SEED }}
      title: My Product
      description: A reusable canister package
      package-slug: my-product
      release-tag: ${{ github.ref_name }}
      download-url: https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}/my-product.canister_hub.toml
```

The caller supplies its own publishing identity; the action contains no
Canister Hub controller credential. Pin `@v1.0.0` or a commit SHA when an
immutable dependency is preferred over the maintained `@v1` major tag.
`wasm` is always required — its sha256 (or, for a paid listing, the encrypted
output's sha256) is submitted on-chain as `wasm_hash`, which every installer
verifies the bytes it downloads from the manifest's `wasm_url` against before
ever installing them. This is what stops the manifest or the GitHub Release
asset being swapped for something else after publishing: neither one is
itself recorded on-chain, so without this check a later edit to either would
go undetected.

The action also runs `actions/attest-build-provenance` on that same artifact,
which is why `id-token: write`/`attestations: write` are required at the
*job* level (a composite action can't grant permissions to itself). This is a
separate, stronger property than `wasm_hash`: a Sigstore-backed proof that
the artifact was actually produced by *this repository's own CI*, not just
uploaded by whoever controls it. The orchestrator's agent-driven install path
(`services/orchestrator/src/provenance.rs`) verifies this before installing a
free item and refuses to proceed without it — skipping these permissions
means that install path will reject every release.

For a paid listing, also grant `contents: write`, pass
`github-token: ${{ secrets.GITHUB_TOKEN }}`; the action encrypts
the Wasm and uploads the encrypted output to the existing GitHub Release before
registering its URL with the marketplace. Free listings expect their public
release asset to exist already and do not need a GitHub token.

## `publish_to_marketplace.js`

Every listing points to either `canister_hub.toml` or a package-specific
`<package-slug>.canister_hub.toml` GitHub Release asset. The slug is the stable
identity within a repository: publishing the same slug updates its listing,
while a different slug creates another item with separate purchases and
vetKey access.
For a package, that manifest resolves the actual installable artifact:

```toml
schema_version = 1

[package]
name = "my-package"
version = "1.0.0"
wasm_url = "https://github.com/owner/repo/releases/download/v1/my-package.wasm"
```

Templates use the existing `[template]`, `[[packages]]`, `[[configure]]`, and
`[environment]` manifest sections. Pass `item-type: template` when publishing
one; templates are public/free and use the same marketplace catalog as
packages.

What a publisher's own CI runs to list an item on the marketplace:

- **Free item** (no `PRICE`): publishes the listing as-is, no encryption.
- **Paid item** (`PRICE` set to a positive u64 ICP amount in e8s): generates
  a fresh random AES-256 key, encrypts
  the release artifact with it, IBE-encrypts *that key* to the item's own
  vetkey identity (derived from its GitHub repo and package slug via the canister's
  `item_key_name`), and submits the ciphertext to `publish_marketplace_item`. The
  canister only ever stores that ciphertext — it can't decrypt it itself.
  A buyer later granted read access (`set_user_rights`, typically called by
  the publisher once payment is confirmed) derives the matching vetkey via
  `get_encrypted_vetkey` and decrypts the ciphertext client-side to recover
  the AES key.

At install time the buyer approves the backend on the ICP ledger for the
listing's exact e8s amount plus the live transfer fee. The backend then calls
`icrc2_transfer_from` to pay the verified publisher and grants vetkey `Read`
access only after that transfer is confirmed.

Run it with `npm run publish` and the env vars documented at the top of the
file. Before a repo's first publish, its owner must connect it via the
dashboard's "Connect Git" flow (`/market/publisher`), with the principal
reconstructed by the publishing workflow as the `publisher` to bind. This
isn't a self-reported claim: the dashboard sends it through the
orchestrator's real GitHub OAuth verification
(`services/orchestrator/src/github.rs`), which confirms admin access to the
repo via GitHub's own API before `register_repo_publisher` is ever called -
that method is controller-only now (see its doc comment in
`backend/src/lib.rs`) and rejects any other caller outright.
`publish_marketplace_item` itself is unaffected: it still checks its caller
against whichever publisher principal ended up registered that way.

This script does not itself attest build provenance - that's a separate
`actions/attest-build-provenance` step `publish_to_market/action.yml` runs
automatically (see that file and its own README section above). Calling this
script directly rather than through that action means producing that
attestation yourself, on whichever file this script hashes into `wasm_hash`
(`OUT_FILE` for a paid item, `IN_FILE` for a free one) - without it, the
orchestrator's agent-driven install path refuses to install the item (see
`services/orchestrator/README.md`'s "Build provenance" section).

## `print_ci_principal.js`

One-time setup helper: prints the publisher principal for a given
64-hex-character Ed25519 seed. Connect that principal to the repository via
the dashboard's "Connect Git" flow before its first marketplace publish:

```bash
seed=$(openssl rand -hex 32)
node print_ci_principal.js "$seed"
# paste it into /market/publisher's "Connect Git", then store `seed` as a repo/org secret
```
