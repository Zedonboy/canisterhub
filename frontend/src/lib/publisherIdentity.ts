// A marketplace publisher's own identity - entirely local key material,
// generated or reconstructed in the browser and never sent anywhere as a
// secret (only the resulting *principal* is ever visible to `backend`,
// via whichever call this identity signs). Lets someone's own CI
// (GitHub Actions or otherwise) call `publish_marketplace_item` later as this exact
// same principal, by reconstructing it from the seed phrase they store as a
// repo secret. Binding this principal to a real GitHub repo now goes
// through the "Connect Git" OAuth flow (see `lib/githubConnect.ts`), not a
// direct call from here - `backend::register_repo_publisher` is
// controller-only (see its own doc comment): this dashboard can no longer
// register a repo claim itself, only ask the orchestrator to do so after it
// has independently verified GitHub ownership.
//
// A real BIP-39 mnemonic (`@scure/bip39`, already a transitive dependency
// of `@icp-sdk/auth` - listed here as a direct one since this file leans
// on it directly), not a bespoke scheme - any standard BIP-39 tool can
// generate/validate the same phrase, even though the *seed-to-identity*
// step below (first 32 bytes of the BIP-39 seed, fed to
// `Ed25519KeyIdentity.generate`) is this app's own convention, not a
// standard derivation path - whatever reconstructs this identity in CI
// must do exactly that, not assume some other wallet's derivation.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";

/** 24 words (256-bit strength) - this identity can publish as a
 * verified repo owner, so it's worth the extra words over the BIP-39
 * default 128-bit/12-word strength. */
export function generateSeedPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function isValidSeedPhrase(phrase: string): boolean {
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

/** Deterministic: the same phrase always reconstructs the same identity
 * (and therefore the same principal) - that's the entire point, since a
 * publisher's CI needs to rebuild this exact identity from the phrase it
 * reads out of a repo secret on every run. */
export function identityFromSeedPhrase(phrase: string): Ed25519KeyIdentity {
  const seed = mnemonicToSeedSync(phrase.trim().toLowerCase());
  return Ed25519KeyIdentity.generate(seed.slice(0, 32));
}
