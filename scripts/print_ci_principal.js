#!/usr/bin/env node
// One-time setup helper: prints the publisher principal for a CI identity
// seed so a signed-in dashboard caller can pass it to register_repo_publisher:
//
//   seed=$(openssl rand -hex 32)
//   node scripts/print_ci_principal.js "$seed"
//   icp canister call backend register_repo_publisher \
//     '("https://github.com/owner/repo", principal "<printed principal>")'
//   # Then store `seed` as the publisher identity secret.
"use strict";

// ESM — see the comment at the top of derive_wasm_key_and_encrypt.js for why.
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";

const seedHex = process.argv[2];
if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  console.error(
    "usage: node scripts/print_ci_principal.js <64-char-hex-seed>\n" +
      "generate one with: openssl rand -hex 32"
  );
  process.exit(1);
}

const identity = Ed25519KeyIdentity.generate(Buffer.from(seedHex, "hex"));
console.log(identity.getPrincipal().toText());
