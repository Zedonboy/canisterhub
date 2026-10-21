// Real client-side vetKD decryption for a paid marketplace item's release
// artifact - the buyer-side half of `scripts/publish_to_marketplace.js`'s
// publish-side encryption. No reference implementation existed anywhere in
// this repo before this file; every step here is verified directly against
// the real, currently-published `@icp-sdk/vetkeys@0.7` package's own type
// declarations (not `@dfinity/vetkeys@0.4.0`, which the publish-side
// scripts use - that package is frozen/legacy per the vetkd skill's own
// guidance) and against `backend/src/lib.rs`'s real candid methods.
//
// The real format, exactly as the publisher writes it (see
// `scripts/publish_to_marketplace.js`):
// - `MarketplaceItem.encrypted_key` = `IbeCiphertext.serialize()` bytes, IBE-
//   encrypted under `backend`'s own `DerivedPublicKey` (from
//   `get_vetkey_verification_key`) to the identity
//   `keyIdToVetkdInput(backendPrincipal, itemKeyNameBytes)` - this is also
//   the exact `input` a real buyer's own `EncryptedVetKey.decryptAndVerify`
//   call below must pass, since this `KeyManager` design backs both the
//   symmetric derivation and the IBE identity with the same vetkd input.
// - The Wasm artifact resolved from the item's `canister_hub.toml` is
//   `[12-byte random nonce][AES-256-GCM ciphertext+tag]` of the plaintext
//   wasm, encrypted with a random AES-256 key (the one `encrypted_key`
//   protects) - a plain WebCrypto `AES-GCM` layout, not anything vetKD-
//   specific.

import { TransportSecretKey, DerivedPublicKey, EncryptedVetKey, IbeCiphertext } from "@icp-sdk/vetkeys";
import type { Principal } from "@icp-sdk/core/principal";
import { parse } from "smol-toml";
import { backendCanisterId, getMarketplaceActor } from "./actors";
import { MarketplaceItemType, type MarketplaceItem } from "../bindings/backend";

/** Mirrors `ic_vetkeys::key_manager`'s own vetKD derivation input layout
 * exactly (byte for byte) - see `scripts/publish_to_marketplace.js`'s own
 * `keyIdToVetkdInput`, which this must match for a derived vetkey to
 * actually decrypt/verify against what the publisher encrypted. */
/** Confirms the just-downloaded release artifact is byte-for-byte what the
 * verified publisher recorded on-chain at publish time. The manifest at
 * `item.download_url` and the GitHub Release asset its `wasm_url` points at
 * are both off-chain and publisher-mutable *after* publishing (a release
 * asset can be swapped without changing its URL) - `item.wasm_hash` is the
 * one part of this install path that can't be, so every install must check
 * the downloaded bytes against it before ever being installed. */
async function verifyWasmHash(bytes: Uint8Array, expectedHash: Uint8Array): Promise<void> {
  const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  const matches = actualHash.length === expectedHash.length && actualHash.every((byte, i) => byte === expectedHash[i]);
  if (!matches) {
    throw new Error(
      "downloaded release artifact's sha256 does not match this item's recorded wasm_hash - " +
        "the manifest or release asset may have been swapped after publishing"
    );
  }
}

function keyIdToVetkdInput(owner: Principal, keyName: Uint8Array): Uint8Array {
  const ownerBytes = owner.toUint8Array();
  const out = new Uint8Array(1 + ownerBytes.length + keyName.length);
  out[0] = ownerBytes.length;
  out.set(ownerBytes, 1);
  out.set(keyName, 1 + ownerBytes.length);
  return out;
}

/** Derives and IBE-unwraps this item's real AES key - the caller must
 * already hold `AccessRights::Read` on it (granted via
 * `backend::set_user_rights`); this codebase has no purchase/payment flow
 * yet, so a caller without access gets a real, expected `Err` here, not a
 * bug to route around. */
async function decryptItemAesKey(item: MarketplaceItem): Promise<Uint8Array> {
  const actor = await getMarketplaceActor();
  const backendId = backendCanisterId();

  const keyNameResult = await actor.item_key_name(item.git_repo_url, item.package_slug);
  if ("Err" in keyNameResult) throw new Error(`couldn't resolve this item's vetkey name: ${keyNameResult.Err}`);
  const keyNameBytes = keyNameResult.Ok;

  const tsk = TransportSecretKey.random();
  const [encryptedVetkeyResult, verificationKey] = await Promise.all([
    actor.get_encrypted_vetkey(backendId, { inner: keyNameBytes }, { inner: tsk.publicKeyBytes() }),
    actor.get_vetkey_verification_key(),
  ]);
  if ("Err" in encryptedVetkeyResult) {
    throw new Error(`you don't have access to decrypt this item yet: ${encryptedVetkeyResult.Err}`);
  }

  const vetkdInput = keyIdToVetkdInput(backendId, keyNameBytes);
  const dpk = DerivedPublicKey.deserialize(verificationKey.inner);
  const vetKey = EncryptedVetKey.deserialize(encryptedVetkeyResult.Ok.inner).decryptAndVerify(tsk, dpk, vetkdInput);

  if (!item.encrypted_key) throw new Error("this item has no encrypted_key to unwrap (it should have been treated as free)");
  return IbeCiphertext.deserialize(item.encrypted_key).decrypt(vetKey);
}

/** Downloads and, if gated, decrypts a marketplace item's real wasm binary.
 * A free item (`encrypted_key` is `[]`) is just fetched directly - the
 * artifact itself is already the plaintext wasm, no crypto involved at all. */
export async function fetchMarketplaceWasm(item: MarketplaceItem): Promise<Uint8Array> {
  if (item.item_type !== MarketplaceItemType.Package) throw new Error("templates cannot be installed as a single Wasm package");
  const manifestResponse = await fetch(item.download_url);
  if (!manifestResponse.ok) {
    throw new Error(`failed to download canister_hub.toml: ${manifestResponse.status} ${manifestResponse.statusText}`);
  }
  const manifest = parse(await manifestResponse.text()) as { package?: { wasm_url?: unknown } };
  const wasmUrl = manifest.package?.wasm_url;
  if (typeof wasmUrl !== "string" || !/^https?:\/\//.test(wasmUrl)) {
    throw new Error("package canister_hub.toml must contain an absolute package.wasm_url");
  }
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`failed to download release artifact: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyWasmHash(bytes, item.wasm_hash);

  if (!item.encrypted_key) return bytes;

  const aesKeyBytes = await decryptItemAesKey(item);
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(aesKeyBytes), { name: "AES-GCM" }, false, ["decrypt"]);
  const nonce = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext);
  return new Uint8Array(plaintext);
}
