use crate::config::Config;
use bip32::{DerivationPath, XPrv};
use bip39::{Language, Mnemonic, Seed};
use candid::Principal;
use ic_agent::identity::{AnonymousIdentity, BasicIdentity, Secp256k1Identity};
use ic_agent::{Agent, Identity};
use std::path::Path;
use std::sync::Arc;

/// Builds an `ic-agent` client. `local` controls whether the replica's root key is
/// fetched (required for any non-mainnet replica, whose root key isn't the
/// well-known NNS one baked into ic-agent) and must never be set for mainnet.
pub async fn build_agent(
    url: &str,
    identity: Arc<dyn Identity>,
    local: bool,
) -> anyhow::Result<Agent> {
    let agent = Agent::builder()
        .with_url(url)
        .with_arc_identity(identity)
        .build()?;
    if local {
        agent.fetch_root_key().await?;
    }
    Ok(agent)
}

/// Builds an agent for `network` ("local" | "ic") using `config`'s configured
/// identity and the matching replica URL, returning it along with that
/// identity's principal. `require_identity` controls what happens when no
/// identity is configured: error out (for anything that needs to write, e.g.
/// indexing or deploying) or fall back to the anonymous identity (for
/// read-only uses).
pub async fn build_agent_for_network(
    config: &Config,
    network: &str,
    require_identity: bool,
) -> anyhow::Result<(Agent, Principal)> {
    let local = network != "ic";
    let url = if local {
        &config.ic_url_local
    } else {
        &config.ic_url_mainnet
    };

    let identity = match resolve_identity(config)? {
        Some(identity) => identity,
        None if require_identity => {
            anyhow::bail!("no identity configured (set IDENTITY_SEED_PHRASE or DEPLOY_IDENTITY_PEM) - this operation needs a real (non-anonymous) identity")
        }
        None => anonymous_identity(),
    };
    let principal = identity
        .sender()
        .map_err(|e| anyhow::anyhow!("failed to derive principal from identity: {e}"))?;
    let agent = build_agent(url, identity, local).await?;
    Ok((agent, principal))
}

/// `IDENTITY_SEED_PHRASE` takes priority over `DEPLOY_IDENTITY_PEM` when both
/// are set (uncommon, but a seed phrase is the more explicit choice of the
/// two). `None` means neither is configured.
fn resolve_identity(config: &Config) -> anyhow::Result<Option<Arc<dyn Identity>>> {
    if let Some(phrase) = &config.identity_seed_phrase {
        return Ok(Some(identity_from_seed_phrase(phrase)?));
    }
    if let Some(path) = &config.deploy_identity_pem {
        return Ok(Some(load_identity_from_pem(path)?));
    }
    Ok(None)
}

pub fn anonymous_identity() -> Arc<dyn Identity> {
    Arc::new(AnonymousIdentity)
}

/// The BIP-32 path `dfx identity new --storage-mode plaintext <name>` (a
/// "seed phrase" identity) derives its key at - `223` is the Internet
/// Computer's SLIP-44 coin type. Matching this exactly (rather than picking
/// our own path) means the same seed phrase produces the same principal here
/// as it would in dfx, so `IDENTITY_SEED_PHRASE` can reuse an identity you
/// already control instead of minting a new, unfamiliar one.
const IC_DERIVATION_PATH: &str = "m/44'/223'/0'/0/0";

/// Derives a Secp256k1 identity from a BIP-39 mnemonic the same way dfx does
/// for its seed-phrase identities (see `IC_DERIVATION_PATH`'s doc comment) -
/// English wordlist, empty BIP-39 passphrase. `phrase` is never logged; treat
/// `IDENTITY_SEED_PHRASE` with the same care as a private key, since that's
/// what it deterministically is.
pub fn identity_from_seed_phrase(phrase: &str) -> anyhow::Result<Arc<dyn Identity>> {
    let mnemonic = Mnemonic::from_phrase(phrase.trim(), Language::English)
        .map_err(|e| anyhow::anyhow!("IDENTITY_SEED_PHRASE is not a valid BIP-39 mnemonic: {e}"))?;
    let seed = Seed::new(&mnemonic, "");

    let path: DerivationPath = IC_DERIVATION_PATH
        .parse()
        .expect("IC_DERIVATION_PATH is a valid BIP-32 path");
    let extended_key = XPrv::derive_from_path(seed.as_bytes(), &path)
        .map_err(|e| anyhow::anyhow!("failed to derive key from seed phrase: {e}"))?;
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
    let id = BasicIdentity::from_pem_file(path).map_err(|e| {
        anyhow::anyhow!(
            "failed to load identity from {}: not a recognized Secp256k1 or Ed25519 PEM ({e})",
            path.display()
        )
    })?;
    Ok(Arc::new(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-checked against real `dfx`: `dfx identity import x --seed-file
    /// <file with this phrase> --storage-mode plaintext` then `dfx identity
    /// get-principal` gives `tgzar-4lpln-fq34h-6hxo4-wlm3x-6g3or-6hxvr-d6jbw-ooh2b-lzsw4-aqe`
    /// for this exact (standard BIP-39 test vector) phrase.
    #[test]
    fn seed_phrase_derivation_matches_dfx() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let identity = identity_from_seed_phrase(phrase).expect("valid phrase");
        let principal = identity.sender().expect("sender");
        assert_eq!(
            principal.to_text(),
            "tgzar-4lpln-fq34h-6hxo4-wlm3x-6g3or-6hxvr-d6jbw-ooh2b-lzsw4-aqe"
        );
    }
}
