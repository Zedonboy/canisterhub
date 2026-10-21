#!/usr/bin/env node
// Derives an AES-256 key on demand from a canister's vetKD-backed
// `ic_vetkeys::key_manager::KeyManager`, and uses it to AES-256-GCM encrypt a
// file. Works against *any* canister that exposes KeyManager's standard
// candid interface (`get_encrypted_vetkey` / `get_vetkey_verification_key` /
// `set_user_rights` / …) — not specific to any one project. See the `vetkd`
// skill for the model this follows:
// https://skills.internetcomputer.org/.well-known/skills/vetkd/SKILL.md
//
// The calling identity must already be an authorized reader of the target
// vetkey (granted via the canister's `set_user_rights` method) — this
// script only derives and encrypts, it doesn't request access.
//
// Output layout: [12-byte nonce] + [ciphertext] + [16-byte auth tag].
//
// Usage: node derive_key_and_encrypt.js <in-file> <out-file>
// Env:
//   CANISTER_ID            principal of the target canister
//   IC_HOST                e.g. https://icp0.io (mainnet) or a local replica URL
//   IDENTITY_SEED          64-char hex string (32-byte Ed25519 seed) for an
//                          identity already granted read access
//   KEY_OWNER              principal that "owns" the vetkey (KeyManager's
//                          (owner, name) scheme). Defaults to CANISTER_ID.
//   KEY_NAME               UTF-8 vetkey name, 32 bytes or fewer
//   AES_DOMAIN_SEPARATOR   local HKDF domain separator for the AES-GCM key —
//                          never sent to the canister; must match whatever
//                          decrypts the output file later
"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import { HttpAgent, Actor } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import { KeyManager } from "@dfinity/vetkeys/key_manager";
import { VetKey } from "@dfinity/vetkeys";

// Minimal candid interface covering only the KeyManager-shaped methods this
// script calls — works against any canister implementing them, regardless
// of what else its full interface exposes.
const idlFactory = ({ IDL }) => {
  const ByteBuf = IDL.Record({ inner: IDL.Vec(IDL.Nat8) });
  const AccessRights = IDL.Variant({
    Read: IDL.Null,
    ReadWrite: IDL.Null,
    ReadWriteManage: IDL.Null,
  });
  const GetKeyResult = IDL.Variant({ Ok: ByteBuf, Err: IDL.Text });
  const RightsResult = IDL.Variant({ Ok: IDL.Opt(AccessRights), Err: IDL.Text });
  return IDL.Service({
    get_accessible_shared_key_ids: IDL.Func(
      [],
      [IDL.Vec(IDL.Tuple(IDL.Principal, ByteBuf))],
      ["query"]
    ),
    get_encrypted_vetkey: IDL.Func([IDL.Principal, ByteBuf, ByteBuf], [GetKeyResult], []),
    get_user_rights: IDL.Func([IDL.Principal, ByteBuf, IDL.Principal], [RightsResult], ["query"]),
    get_vetkey_verification_key: IDL.Func([], [ByteBuf], []),
    remove_user: IDL.Func([IDL.Principal, ByteBuf, IDL.Principal], [RightsResult], []),
    set_user_rights: IDL.Func(
      [IDL.Principal, ByteBuf, IDL.Principal, AccessRights],
      [RightsResult],
      []
    ),
  });
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node derive_key_and_encrypt.js <in-file> <out-file>");
    process.exit(1);
  }

  const canisterId = requireEnv("CANISTER_ID");
  const host = process.env.IC_HOST || "https://icp0.io";
  const seedHex = requireEnv("IDENTITY_SEED");
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    console.error("IDENTITY_SEED must be a 64-character hex string (32 bytes)");
    process.exit(1);
  }
  const keyOwnerText = process.env.KEY_OWNER || canisterId;
  const keyName = requireEnv("KEY_NAME");
  const keyNameBytes = new TextEncoder().encode(keyName);
  if (keyNameBytes.length > 32) {
    console.error("KEY_NAME must be 32 bytes or fewer once UTF-8 encoded");
    process.exit(1);
  }
  const aesDomainSep = requireEnv("AES_DOMAIN_SEPARATOR");

  const identity = Ed25519KeyIdentity.generate(Buffer.from(seedHex, "hex"));
  const agent = await HttpAgent.create({ host, identity });
  if (host.includes("localhost") || host.includes("127.0.0.1")) {
    // Local/test replicas sign with a throwaway root key the agent doesn't
    // trust by default; mainnet must never take this branch.
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor(idlFactory, { agent, canisterId });

  // `KeyManager` only needs an object with the right async methods — a
  // canister implementing the standard interface already has exactly that
  // shape. It generates a fresh transport keypair, calls
  // `get_encrypted_vetkey`, and decrypts-and-verifies the response against
  // `get_vetkey_verification_key` internally.
  const keyManager = new KeyManager(actor);
  const keyOwner = Principal.fromText(keyOwnerText);
  const vetKeyBytes = await keyManager.getVetkey(keyOwner, keyNameBytes);
  const vetKey = VetKey.deserialize(vetKeyBytes);

  const derivedKeyMaterial = await vetKey.asDerivedKeyMaterial();
  const aesKey = await derivedKeyMaterial.deriveAesGcmCryptoKey(aesDomainSep);

  const plaintext = fs.readFileSync(inPath);
  const nonce = crypto.randomBytes(12);
  const ciphertextAndTag = Buffer.from(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  const payload = Buffer.concat([nonce, ciphertextAndTag]);
  fs.writeFileSync(outPath, payload);

  console.log(`Encrypted ${plaintext.length} bytes -> ${payload.length} bytes (${outPath})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
