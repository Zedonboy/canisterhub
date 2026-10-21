# vetKD encrypt

A GitHub Action that derives an AES-256 key on demand from an [Internet
Computer](https://internetcomputer.org) canister's [vetKD](https://internetcomputer.org/docs/building-apps/network-features/vetkeys/introduction)-backed
`KeyManager` and uses it to AES-256-GCM encrypt a file — no static secret
ever lives in your CI environment or in the canister itself.

It works against **any** canister that implements the standard candid
interface from the [`ic-vetkeys`](https://docs.rs/ic-vetkeys) Rust crate's
`KeyManager` (`get_encrypted_vetkey`, `get_vetkey_verification_key`, `set_user_rights`,
`get_user_rights`, `remove_user`, `get_accessible_shared_key_ids`) — it isn't
specific to this repository. See the
[`vetkd` skill](https://skills.internetcomputer.org/.well-known/skills/vetkd/SKILL.md)
for the underlying model.

## Prerequisites

1. Your canister uses `ic_vetkeys::key_manager::KeyManager` and exposes its
   methods under those standard names (this repo's `backend/src/lib.rs` is a
   working example).
2. An identity has been granted `Read` access to the specific `(owner, name)`
   vetkey you want, via the canister's `set_user_rights` method. Generate a
   fresh identity and find its principal with:

   ```bash
   seed=$(openssl rand -hex 32)
   node -e "
     import('@icp-sdk/core/identity').then(({ Ed25519KeyIdentity }) => {
       console.log(Ed25519KeyIdentity.generate(Buffer.from(process.argv[1], 'hex')).getPrincipal().toText());
     });
   " "$seed"
   ```

   then grant it (via `dfx`, an admin script, or however your canister's
   access control is driven), and store `seed` as a secret in your repo/org
   (e.g. `IDENTITY_SEED`).

## Usage

```yaml
- uses: <owner>/canister_hub/vetkd-encrypt-action@v1
  with:
    canister-id: "aaaaa-bbbbb-ccccc-ddddd-cai"
    identity-seed: ${{ secrets.IDENTITY_SEED }}
    key-name: "my-app-secret-key"
    aes-domain-separator: "my-app-aes-key-v1"
    in-file: build/app.bin
    out-file: build/app.bin.enc
```

Replace `<owner>/canister_hub` with wherever this repository actually lives,
and pin to a tagged release (`@v1`) rather than `@main` for stability once
one exists.

### Inputs

| Input                   | Required | Default              | Description                                                                                     |
| ------------------------ | :------: | -------------------- | ------------------------------------------------------------------------------------------------- |
| `canister-id`            |    ✅    | —                     | Principal of the canister exposing the KeyManager interface.                                     |
| `ic-host`                |          | `https://icp0.io`    | IC HTTP gateway host to call. Use a local replica URL for testing.                               |
| `identity-seed`          |    ✅    | —                     | 64-char hex (32-byte) Ed25519 seed for an identity already granted read access. Pass as a secret. |
| `key-owner`              |          | `canister-id`         | Principal that "owns" the vetkey, per KeyManager's `(owner, name)` scheme.                       |
| `key-name`               |    ✅    | —                     | UTF-8 vetkey name, 32 bytes or fewer.                                                            |
| `aes-domain-separator`   |    ✅    | —                     | Local HKDF domain separator for the AES-GCM key. Never sent to the canister — must match whatever decrypts the output later. |
| `in-file`                |    ✅    | —                     | Path to the plaintext file to encrypt.                                                          |
| `out-file`               |    ✅    | —                     | Path to write the encrypted output to.                                                          |

### Outputs

| Output     | Description                                       |
| ---------- | -------------------------------------------------- |
| `out-file` | Path to the encrypted output file (echoes the input). |

### Output file format

`[12-byte nonce] + [ciphertext] + [16-byte AES-GCM auth tag]`

## What this does *not* do

This action only **derives and encrypts** — it assumes the calling identity
is already authorized. It doesn't request access, doesn't verify anything
about the file's provenance, and doesn't publish anywhere; wire it into your
own release workflow around those concerns as needed.

## Limitations

- vetKD's availability varies by subnet/environment; verify it's enabled
  where your canister is deployed before relying on this in production.
- The identity-granting step above is a one-time manual (or separately
  automated) prerequisite — this action does not manage entitlements.
