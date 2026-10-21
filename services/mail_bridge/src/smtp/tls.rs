//! Builds the `TlsAcceptor` the `STARTTLS` command (RFC 3207) upgrades a
//! connection with.

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use std::path::Path;
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;

/// Installs `ring` as the process-wide default crypto provider. Idempotent
/// (`.ok()`s the "already installed" error): another rustls-using dependency
/// in this binary (reqwest, lettre, ic-agent) may already have installed one
/// first, in which case this is a no-op rather than a startup failure.
pub fn install_default_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn build_acceptor(cert_path: &Path, key_path: &Path) -> anyhow::Result<TlsAcceptor> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert_path)
        .map_err(|e| anyhow::anyhow!("failed to read TLS_CERT_PATH ({}): {e}", cert_path.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| anyhow::anyhow!("failed to parse TLS_CERT_PATH ({}): {e}", cert_path.display()))?;
    if certs.is_empty() {
        anyhow::bail!("TLS_CERT_PATH ({}) contains no certificates", cert_path.display());
    }

    let key = PrivateKeyDer::from_pem_file(key_path).map_err(|e| anyhow::anyhow!("failed to read/parse TLS_KEY_PATH ({}): {e}", key_path.display()))?;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| anyhow::anyhow!("invalid TLS certificate/key pair: {e}"))?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}
