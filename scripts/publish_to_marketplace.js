#!/usr/bin/env node
// Publishes an item to the canister_hub marketplace, end to end:
//
//   1. If PRICE is set, generates a fresh random AES-256 key, encrypts
//      IN_FILE with it (GitHub — this script, running in your CI — performs
//      the encryption), IBE-encrypts *that key* to the item's own vetkey
//      identity (via the canister's get_vetkey_verification_key +
//      item_key_name), and submits the resulting ciphertext to
//      publish_marketplace_item.
//      The canister only ever stores/sees that ciphertext — it can't decrypt
//      it itself, only forward the matching vetkey to a buyer it has granted
//      access to (see set_user_rights).
//   2. If PRICE is unset, nothing is encrypted — the item is published as a
//      plain, freely downloadable release, and no key material is generated
//      or submitted at all.
//
// This assumes `request_publish_challenge` + pasting the token into a GitHub
// Release's notes has already happened for a *new* repo claim — publishing
// enforces that itself and will fail with a clear message if it hasn't. A
// principal republishing/updating a repo it already owns skips that step.
//
// Usage: node scripts/publish_to_marketplace.js
// Env:
//   BACKEND_CANISTER_ID     principal of the deployed backend canister
//   IC_HOST                 e.g. https://icp0.io (mainnet) or a local replica URL
//   PUBLISHER_IDENTITY_SEED 64-char hex string (32-byte Ed25519 seed) for the
//                           publishing identity
//   GIT_REPO_URL            e.g. https://github.com/owner/repo
//   TITLE, DESCRIPTION      listing text
//   WEB_URL                 optional homepage/docs URL
//   ITEM_TYPE               package (default) or template
//   PACKAGE_SLUG            stable lowercase identity within the repository
//   DOWNLOAD_URL            absolute URL of the release's canister_hub.toml
//   RELEASE_TAG             the GitHub release tag this listing points to
//   PRICE                   optional u64 ICP price in e8s; omit for free
//   IN_FILE                 local path to the release artifact — always
//                           required: its sha256 (or, for a paid item, the
//                           encrypted output's sha256) is submitted as
//                           wasm_hash, which installers verify the bytes
//                           they fetch from wasm_url against
//   OUT_FILE                required only when PRICE is set: encrypted
//                           output path
"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { HttpAgent, Actor } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { DerivedPublicKey, IbeCiphertext, IbeIdentity, IbeSeed } from "@dfinity/vetkeys";
import { idlFactory } from "./bindings/backend.did.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return v;
}

// Reconstructs `ic_vetkeys::key_manager::key_id_to_vetkd_input`: the exact
// byte layout the canister uses as vetKD `input` — and so also the IBE
// identity that must be encrypted to, for the resulting vetkey to actually
// decrypt what's IBE-encrypted here.
function keyIdToVetkdInput(ownerPrincipal, keyNameBytes) {
  const ownerBytes = ownerPrincipal.toUint8Array();
  return new Uint8Array([ownerBytes.length, ...ownerBytes, ...keyNameBytes]);
}

async function main() {
  const canisterId = requireEnv("BACKEND_CANISTER_ID");
  const host = process.env.IC_HOST || "https://icp0.io";
  const seedHex = requireEnv("PUBLISHER_IDENTITY_SEED");
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    console.error("PUBLISHER_IDENTITY_SEED must be a 64-character hex string (32 bytes)");
    process.exit(1);
  }
  const gitRepoUrl = requireEnv("GIT_REPO_URL");
  const title = requireEnv("TITLE");
  const description = requireEnv("DESCRIPTION");
  const itemType = (process.env.ITEM_TYPE || "package").toLowerCase();
  if (itemType !== "package" && itemType !== "template") {
    throw new Error("ITEM_TYPE must be package or template");
  }
  const packageSlug = requireEnv("PACKAGE_SLUG");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(packageSlug)) {
    throw new Error("PACKAGE_SLUG must start with a lowercase letter or digit and contain only lowercase letters, digits, '.', '_', or '-'");
  }
  const downloadUrl = requireEnv("DOWNLOAD_URL");
  const releaseTag = requireEnv("RELEASE_TAG");
  const webUrl = process.env.WEB_URL || null;
  const priceRaw = process.env.PRICE;
  if (priceRaw && priceRaw.trim() !== "" && !/^\d+$/.test(priceRaw.trim())) {
    throw new Error("PRICE must be a decimal u64 amount in ICP e8s");
  }
  const price = priceRaw && priceRaw.trim() !== "" ? BigInt(priceRaw.trim()) : null;
  if (price !== null && (price <= 0n || price > 18_446_744_073_709_551_615n)) {
    throw new Error("PRICE must be a positive u64 amount in ICP e8s");
  }
  if (itemType === "template" && price !== null) {
    throw new Error("template items must be public and free");
  }

  const identity = Ed25519KeyIdentity.generate(Buffer.from(seedHex, "hex"));
  const agent = await HttpAgent.create({ host, identity });
  if (host.includes("localhost") || host.includes("127.0.0.1")) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor(idlFactory, { agent, canisterId });
  const canisterPrincipal = Principal.fromText(canisterId);

  // Required unconditionally, not just for a paid item: whatever this path
  // holds is hashed below into `wasm_hash`, checked at install time against
  // whatever bytes actually end up served from the manifest's `wasm_url` —
  // the AES-encrypted artifact for a paid item (see `outFile` below), the
  // plaintext release artifact itself for a free one.
  const inFile = requireEnv("IN_FILE");
  let hashSourceFile = inFile;

  let encryptedKeyBytes = null;
  if (price !== null) {
    const outFile = requireEnv("OUT_FILE");

    // 1. GitHub (this script) generates a fresh random key and performs the
    //    encryption — no vetKD interaction needed for this part at all.
    const aesKeyBytes = crypto.randomBytes(32);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const plaintext = fs.readFileSync(inFile);
    const nonce = crypto.randomBytes(12);
    const ciphertextAndTag = Buffer.from(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
    );
    fs.writeFileSync(outFile, Buffer.concat([nonce, ciphertextAndTag]));
    console.log(`Encrypted ${plaintext.length} bytes -> ${outFile}`);
    hashSourceFile = outFile;

    if (process.env.UPLOAD_ENCRYPTED_RELEASE_ASSET === "true") {
      const uploadToken = requireEnv("RELEASE_UPLOAD_TOKEN");
      const uploadRepository = requireEnv("RELEASE_UPLOAD_REPOSITORY");
      execFileSync(
        "gh",
        ["release", "upload", releaseTag, outFile, "--repo", uploadRepository, "--clobber"],
        {
          stdio: "inherit",
          env: { ...process.env, GH_TOKEN: uploadToken },
        }
      );
      console.log(`Uploaded encrypted artifact to ${uploadRepository}@${releaseTag}`);
    }

    // 2. IBE-wrap that key to this item's vetkey identity, so only a buyer
    //    who's later granted read access (via set_user_rights) can recover
    //    it — the canister stores only this ciphertext, never the raw key.
    const dpkResult = await actor.get_vetkey_verification_key();
    const dpk = DerivedPublicKey.deserialize(Uint8Array.from(dpkResult.inner));

    const keyNameResult = await actor.item_key_name(gitRepoUrl, packageSlug);
    if ("Err" in keyNameResult) {
      throw new Error(`item_key_name failed: ${keyNameResult.Err}`);
    }
    const identityBytes = keyIdToVetkdInput(
      canisterPrincipal,
      Uint8Array.from(keyNameResult.Ok)
    );

    const ibeCiphertext = IbeCiphertext.encrypt(
      dpk,
      IbeIdentity.fromBytes(identityBytes),
      aesKeyBytes,
      IbeSeed.random()
    );
    encryptedKeyBytes = Array.from(ibeCiphertext.serialize());
  }

  // 3. Hash exactly the bytes an installer will fetch from wasm_url (the
  //    encrypted artifact for a paid item, the plaintext release artifact
  //    for a free one) — this is what anchors install-time integrity
  //    against the manifest or release asset being swapped after this
  //    publish, since neither one is itself recorded on-chain.
  const wasmHashBytes = Array.from(
    crypto.createHash("sha256").update(fs.readFileSync(hashSourceFile)).digest()
  );

  // 4. Submit the listing (and, for a paid item, the wrapped key) to the
  //    marketplace. A first-time claim on GIT_REPO_URL requires
  //    request_publish_challenge to have already been satisfied — see this
  //    file's header comment.
  const result = await actor.publish_marketplace_item(
    itemType === "template" ? { Template: null } : { Package: null },
    webUrl ? [webUrl] : [],
    gitRepoUrl,
    title,
    description,
    downloadUrl,
    releaseTag,
    price !== null ? [price] : [],
    encryptedKeyBytes ? [encryptedKeyBytes] : [],
    packageSlug,
    wasmHashBytes
  );
  if ("Err" in result) {
    throw new Error(`publish_marketplace_item failed: ${result.Err}`);
  }
  console.log(`Published marketplace item #${result.Ok}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `item-id=${result.Ok}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
