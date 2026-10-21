//! Identity + agent construction. Mirrors
//! `services/orchestrator/src/ic/agent.rs` (same reasoning, same dfx-compatible seed-
//! phrase derivation) trimmed to what this service needs: one agent, one
//! network, no deploy/wallet/JWT machinery.

use crate::config::Config;
use bip32::{DerivationPath, XPrv};
use bip39::{Language, Mnemonic, Seed};
use ic_agent::identity::{BasicIdentity, Secp256k1Identity};
use ic_agent::{Agent, Identity};
use std::path::Path;
use std::sync::Arc;

/// Builds this service's `ic-agent` client from `config`'s identity - one of
/// `IDENTITY_SEED_PHRASE` or `DEPLOY_IDENTITY_PEM` is required (enforced in
/// `Config::from_env`), since every use of this agent (calling
/// `receive_mail`) needs a real, non-anonymous caller.
pub async fn build_agent(config: &Config) -> anyhow::Result<Agent> {
    let identity = resolve_identity(config)?;
    let agent = Agent::builder().with_url(&config.ic_url).with_arc_identity(identity).build()?;
    if config.ic_local {
        agent.fetch_root_key().await?;
    }
    Ok(agent)
}

fn resolve_identity(config: &Config) -> anyhow::Result<Arc<dyn Identity>> {
    if let Some(phrase) = &config.identity_seed_phrase {
        return identity_from_seed_phrase(phrase);
    }
    if let Some(path) = &config.deploy_identity_pem {
        return load_identity_from_pem(path);
    }
    anyhow::bail!("no identity configured (set IDENTITY_SEED_PHRASE or DEPLOY_IDENTITY_PEM)")
}

/// The BIP-32 path `dfx identity new --storage-mode plaintext <name>` (a
/// "seed phrase" identity) derives its key at - `223` is the Internet
/// Computer's SLIP-44 coin type. Matching this exactly means the same seed
/// phrase produces the same principal here as it would in dfx. Cross-checked
/// against real `dfx` in orchestrator's test suite
/// (`ic::agent::tests::seed_phrase_derivation_matches_dfx`) - this is a
/// verbatim copy of that same logic.
const IC_DERIVATION_PATH: &str = "m/44'/223'/0'/0/0";

/// Derives a Secp256k1 identity from a BIP-39 mnemonic the same way dfx does
/// for its seed-phrase identities. `phrase` is never logged; treat
/// `IDENTITY_SEED_PHRASE` with the same care as a private key, since that's
/// what it deterministically is.
pub fn identity_from_seed_phrase(phrase: &str) -> anyhow::Result<Arc<dyn Identity>> {
    let mnemonic = Mnemonic::from_phrase(phrase.trim(), Language::English)
        .map_err(|e| anyhow::anyhow!("IDENTITY_SEED_PHRASE is not a valid BIP-39 mnemonic: {e}"))?;
    let seed = Seed::new(&mnemonic, "");

    let path: DerivationPath = IC_DERIVATION_PATH.parse().expect("IC_DERIVATION_PATH is a valid BIP-32 path");
    let extended_key =
        XPrv::derive_from_path(seed.as_bytes(), &path).map_err(|e| anyhow::anyhow!("failed to derive key from seed phrase: {e}"))?;
    let signing_key: k256::ecdsa::SigningKey = extended_key.into();
    let secret_key: k256::SecretKey = signing_key.into();

    Ok(Arc::new(Secp256k1Identity::from_private_key(secret_key)))
}

/// dfx-style identities are usually Secp256k1 (older default) or Ed25519 ("basic",
/// current default since dfx 0.14). Try both so either kind of
/// `dfx identity export` PEM works without the caller having to know which.
pub fn load_identity_from_pem(path: &Path) -> anyhow::Result<Arc<dyn Identity>> {
    if let Ok(id) = Secp256k1Identity::from_pem_file(path) {
        return Ok(Arc::new(id));
    }
    let id = BasicIdentity::from_pem_file(path)
        .map_err(|e| anyhow::anyhow!("failed to load identity from {}: not a recognized Secp256k1 or Ed25519 PEM ({e})", path.display()))?;
    Ok(Arc::new(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same cross-check as orchestrator's - see that crate's test for the
    /// `dfx` commands used to derive the expected principal independently.
    #[test]
    fn seed_phrase_derivation_matches_dfx() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let identity = identity_from_seed_phrase(phrase).expect("valid phrase");
        let principal = identity.sender().expect("sender");
        assert_eq!(principal.to_text(), "tgzar-4lpln-fq34h-6hxo4-wlm3x-6g3or-6hxvr-d6jbw-ooh2b-lzsw4-aqe");
    }
}
