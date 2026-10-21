//! Outbound side of the bridge: a canister's `POST /send_mail` request (see
//! `http::routes`) ends up here, DKIM-signed if `DKIM_PRIVATE_KEY_PATH` is
//! configured, then relayed through the configured upstream SMTP server
//! (`SMTP_RELAY_*`) rather than delivered directly to the recipient's mail
//! server - direct-to-recipient delivery gets spam-filtered without
//! infrastructure (reverse DNS, SPF, DKIM) this bridge doesn't set up.

use crate::config::Config;
use lettre::address::Envelope;
use lettre::message::{Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use mail_auth::common::crypto::{Ed25519Key, RsaKey, Sha256};
use mail_auth::common::headers::HeaderWriter;
use mail_auth::dkim::DkimSigner;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::PrivateKeyDer;
use std::path::Path;

pub struct SendMailRequest {
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
}

pub async fn send_mail(config: &Config, req: &SendMailRequest) -> anyhow::Result<()> {
    if req.to.is_empty() {
        anyhow::bail!("`to` must not be empty");
    }
    if req.text_body.is_none() && req.html_body.is_none() {
        anyhow::bail!("at least one of `text_body`/`html_body` is required");
    }

    let from: Mailbox = req.from.parse().map_err(|e| anyhow::anyhow!("invalid `from` address: {e}"))?;
    let mut builder = Message::builder().from(from).subject(&req.subject);
    for addr in &req.to {
        let mailbox: Mailbox = addr.parse().map_err(|e| anyhow::anyhow!("invalid `to` address '{addr}': {e}"))?;
        builder = builder.to(mailbox);
    }

    let email = match (&req.text_body, &req.html_body) {
        (Some(text), Some(html)) => builder.multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text.clone()))
                .singlepart(SinglePart::html(html.clone())),
        )?,
        (Some(text), None) => builder.singlepart(SinglePart::plain(text.clone()))?,
        (None, Some(html)) => builder.singlepart(SinglePart::html(html.clone()))?,
        (None, None) => unreachable!("checked above"),
    };

    let raw = sign_if_configured(config, &email.formatted());
    send_via_relay(config, email.envelope(), &raw).await
}

/// Actually hands `raw` to the configured upstream SMTP relay - shared by the
/// normal outbound path above and `mail::dsn`'s bounce generation, which
/// needs its own `Envelope` (a null reverse-path) rather than one derived
/// from a `lettre::Message`'s headers.
pub async fn send_via_relay(config: &Config, envelope: &Envelope, raw: &[u8]) -> anyhow::Result<()> {
    // `.relay()` and `.starttls_relay()` differ only in which TLS mode they
    // preconfigure (see `SmtpRelayTls`'s doc comment) - `.port()` below
    // overrides the port either sets by default, but not that TLS mode, so
    // picking the right constructor up front matters.
    let builder = match config.smtp_relay_tls {
        crate::config::SmtpRelayTls::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_relay_host)?,
        crate::config::SmtpRelayTls::Wrapper => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_relay_host)?,
    };
    let mut transport = builder.port(config.smtp_relay_port);
    if !config.smtp_relay_username.is_empty() {
        transport = transport.credentials(Credentials::new(config.smtp_relay_username.clone(), config.smtp_relay_password.0.clone()));
    }
    let transport = transport.build();

    transport
        .send_raw(envelope, raw)
        .await
        .map_err(|e| anyhow::anyhow!("SMTP relay rejected the message: {e}"))?;
    Ok(())
}

/// Signs `raw` (a fully-formatted RFC 5322 message) if `DKIM_PRIVATE_KEY_PATH`
/// is configured, returning it with a `DKIM-Signature` header prepended - or
/// `raw` unchanged otherwise. A signing failure (bad key file, etc) is logged
/// and falls back to sending unsigned rather than dropping the message.
pub fn sign_if_configured(config: &Config, raw: &[u8]) -> Vec<u8> {
    let Some(key_path) = &config.dkim_private_key_path else {
        return raw.to_vec();
    };
    match sign_dkim(config, key_path, raw) {
        Ok(signed) => signed,
        Err(e) => {
            tracing::warn!(error = %e, "DKIM signing failed - sending unsigned");
            raw.to_vec()
        }
    }
}

enum LoadedDkimKey {
    Rsa(RsaKey<Sha256>),
    Ed25519(Ed25519Key),
}

/// Loads `key_path` and figures out which of RSA or Ed25519 it is: a PKCS1
/// PEM is unambiguously RSA, while a PKCS8 PEM could be either algorithm (its
/// own header identifies which) - tried as RSA first since that's the more
/// common/broadly-compatible DKIM key type, falling back to Ed25519. A SEC1
/// PEM (a raw EC key, e.g. P-256) is neither and is rejected: DKIM only
/// defines RSA-SHA256 and Ed25519-SHA256.
fn load_dkim_key(key_path: &Path) -> anyhow::Result<LoadedDkimKey> {
    let key_der = PrivateKeyDer::from_pem_file(key_path)
        .map_err(|e| anyhow::anyhow!("failed to read/parse DKIM_PRIVATE_KEY_PATH ({}): {e}", key_path.display()))?;

    match key_der {
        PrivateKeyDer::Pkcs1(_) => {
            let key = RsaKey::<Sha256>::from_key_der(key_der).map_err(|e| anyhow::anyhow!("invalid RSA DKIM key: {e}"))?;
            Ok(LoadedDkimKey::Rsa(key))
        }
        PrivateKeyDer::Pkcs8(pkcs8) => {
            if let Ok(key) = RsaKey::<Sha256>::from_key_der(PrivateKeyDer::Pkcs8(pkcs8.clone_key())) {
                return Ok(LoadedDkimKey::Rsa(key));
            }
            let key = Ed25519Key::from_pkcs8_der(pkcs8.secret_pkcs8_der())
                .map_err(|e| anyhow::anyhow!("DKIM_PRIVATE_KEY_PATH ({}) is PKCS8 but neither a valid RSA nor Ed25519 key: {e}", key_path.display()))?;
            Ok(LoadedDkimKey::Ed25519(key))
        }
        PrivateKeyDer::Sec1(_) => {
            anyhow::bail!(
                "DKIM_PRIVATE_KEY_PATH ({}) is a raw EC (SEC1) key - DKIM only supports RSA or Ed25519, use one of those instead",
                key_path.display()
            )
        }
        _ => anyhow::bail!("DKIM_PRIVATE_KEY_PATH ({}) is an unrecognized private key format", key_path.display()),
    }
}

fn sign_dkim(config: &Config, key_path: &Path, raw: &[u8]) -> anyhow::Result<Vec<u8>> {
    // Loaded fresh from disk per call rather than cached - signing happens at
    // most once per outbound email (and once per bounce), so the extra file
    // read is not worth the complexity of sharing a non-`Clone` key across
    // calls.
    let key = load_dkim_key(key_path)?;
    let headers = ["From", "To", "Subject", "Date", "Message-ID"];

    let header_text = match key {
        LoadedDkimKey::Rsa(key) => DkimSigner::from_key(key)
            .domain(config.dkim_domain.clone())
            .selector(config.dkim_selector.clone())
            .headers(headers)
            .sign(raw)
            .map_err(|e| anyhow::anyhow!("DKIM signing failed: {e}"))?
            .to_header(),
        LoadedDkimKey::Ed25519(key) => DkimSigner::from_key(key)
            .domain(config.dkim_domain.clone())
            .selector(config.dkim_selector.clone())
            .headers(headers)
            .sign(raw)
            .map_err(|e| anyhow::anyhow!("DKIM signing failed: {e}"))?
            .to_header(),
    };

    let mut signed = header_text.into_bytes();
    signed.extend_from_slice(raw);
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIP/Zvd7GcTaD197yUzu2RKcCtcXwL/nHyzkYc8UXhDg7\n-----END PRIVATE KEY-----\n";

    const RSA_PKCS1_PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA5Tauu41XMIyqVNgXrGZvmDH+jfwABtjeKPELRr/l/Y8e/nB2\nvNY8Ta7Q9mig90JJvfzZPZOuNZyp8wInR9pl7WzhoL2r6IQGyspcjluwD+vkB2dO\nzcpzM8A3udm8peeU3wWyGMz0PjbOQbDS4Jy84HJ5YUuoWqog7RLzE9BuEx3Gp4Vj\nNljYLITUYtPlZBeO0S9G+AKCcxiP2KdIl5F/7yYdVGMgy6QJLL5p1F17p7qcfliq\nS49LYgFs85NiXfXYCEGtnBIBPrrcWs6NYlL6ucdITHzinAUc4gvChqhqDHuav6cx\nY6DFEiTl6u36gukvH/itfmnZyOGKlyodCJ726wIDAQABAoIBAB/gr4NpAE/BuGyt\nUvmIk4uUpGTlv7E0Fw2VnG5eAOP3NCXJyVGw79kT737dhUluACh6klH0iH1vSNmB\nmqntD1DqXCTJTC+9sN4iL6YizUUhluiKrxSCy+vOF1HzHL/sCbHMrnyxgGRopd3P\n9DwFwGTstsHXzlWxpHukL4c5bR2eOpGnrnXYMqjKrj4LuDC2/mULSA1qktdCaGWg\nuWdIAhDRn2SsYUwvc+YyDAMXl0SnZVIs36fsEBBagfz1Xn4mtQrn7c5AthpmJ4Wc\nrkDtxJEaYCSr1cu+F5Cph4zyRq1wMNEJ0C5cP1OY2tcpTY1nH05TFWDSCVZ+5RAH\nlyYA/yUCgYEA/QxFpMAr3LEceifVeDCex/CfhsYTFxgnYQTYDbVlf/7eK1YKlzd5\nvrAV3ppgi1W7ugkiuXRGpDh9aoC6GkM5rYW2QD6TQqvVEldEjyAQxPRp8tBC8V+A\na46Y9J8MTXQTxanNE0/ULm13EWcmO4ALpaOEea5oXT7X3lIikeACrqcCgYEA5+M6\nr2DMBojdqEc2e1hCv4ufA24YI3FgchS6vVV8at8AjlFvFAEYEvf2WnagDv+jvhxz\nMIGR4GDC0Rm7e4ugJMqBLvqHmI4IA/bPVHuyOLlGUtuYw+4BAvtruGsz60hKcjLA\nAR1ZziI8xGgGsojkZgN8Xrt5/WNQK4GjHPTJIh0CgYEA2+B3+2oIMuGqrvJB6QfG\nUFFjLIacO+r+/Kxq166RHaDmh51h4neP0APNXPmjfi7mygX6KE9CuptjTtG/4+Ya\nDg8rh7NX3gzVPfSaXAsuxxThot0X7ghf3BWyDozM8dg0/gJHccphwl3XokWQ0Q64\nEBt/lwPXJ37dsA6Kf1q4ue0CgYEAvU/FmWhtKOiUDc4VrJ1h4P8b0rEPA+CL3JcP\n3YLtEFL/ITFaffpmrRXDChfOlHAgPhT79Z3SelyEsDFR3osfMuogjTn7eZB6+sGE\ngnR6C9U2lG6zSUIFkWmxh939hRh/rrvABSjxKFjLQ42p6hfYX3B5GN31uehaiypL\nAFjX3AECgYEA468XaO6fVYzBWseW/kaacRhosHR1KysDVvVJRQfTSFvp9f2XGa9B\nVKeIqTjkgT2ruBgvMiB35oFGxbtad8WQ4uPvD3pP0ALEKEd9zAkLeQ7efSTvnZmU\nfq6/89fnDAJg5beUL5q5cydKMT/jCeIo0x8tEPQZ1qKw3jWgFprf9S8=\n-----END RSA PRIVATE KEY-----\n";

    const EC_SEC1_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIG39WbuSd0s822OMMLBVAWSbK9B76INA4mgiX1Z7gHjpoAoGCCqGSM49\nAwEHoUQDQgAEwQTURc7o/T2YH7hBOVCCqLGyQYxhX7p1HtvzywghAXRDG3KBQP6O\nyX38F7hPZIAaYlMwn+MlK1MKrS+XxloxnA==\n-----END EC PRIVATE KEY-----\n";

    /// Writes `pem` to a fixed scratch path unique to the caller (tests run in
    /// the same process but never share a filename) and returns it.
    fn write_key(name: &str, pem: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("mail_bridge-relay-test-{name}.pem"));
        std::fs::write(&path, pem).expect("failed to write test key");
        path
    }

    #[test]
    fn load_dkim_key_detects_pkcs1_as_rsa() {
        let path = write_key("pkcs1-rsa", RSA_PKCS1_PEM);
        assert!(matches!(load_dkim_key(&path).unwrap(), LoadedDkimKey::Rsa(_)));
    }

    #[test]
    fn load_dkim_key_detects_pkcs8_ed25519() {
        let path = write_key("pkcs8-ed25519", ED25519_PEM);
        assert!(matches!(load_dkim_key(&path).unwrap(), LoadedDkimKey::Ed25519(_)));
    }

    #[test]
    fn load_dkim_key_rejects_sec1_ec_keys() {
        let path = write_key("sec1-ec", EC_SEC1_PEM);
        let err = match load_dkim_key(&path) {
            Ok(_) => panic!("a SEC1 EC key should be rejected"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("SEC1"), "unexpected error: {err}");
    }

    #[test]
    fn sign_dkim_produces_a_well_formed_header_for_both_key_types() {
        let mut config = test_config();
        let raw = b"From: sender@mail.example.com\r\nTo: rcpt@example.com\r\nSubject: hi\r\nDate: Wed, 01 Jan 2026 00:00:00 +0000\r\nMessage-ID: <1@mail.example.com>\r\n\r\nbody\r\n";

        let rsa_path = write_key("sign-rsa", RSA_PKCS1_PEM);
        config.dkim_private_key_path = Some(rsa_path.clone());
        let signed = sign_dkim(&config, &rsa_path, raw).expect("RSA signing should succeed");
        let header = String::from_utf8_lossy(&signed);
        assert!(header.starts_with("DKIM-Signature:"));
        assert!(header.contains("a=rsa-sha256"));

        let ed_path = write_key("sign-ed25519", ED25519_PEM);
        let signed = sign_dkim(&config, &ed_path, raw).expect("Ed25519 signing should succeed");
        let header = String::from_utf8_lossy(&signed);
        assert!(header.starts_with("DKIM-Signature:"));
        assert!(header.contains("a=ed25519-sha256"));
    }

    fn test_config() -> Config {
        Config {
            smtp_bind_addr: "127.0.0.1:0".into(),
            http_bind_addr: "127.0.0.1:0".into(),
            mail_domain: "mail.example.com".into(),
            max_message_bytes: 1024,
            ic_url: "https://ic0.app".into(),
            ic_local: false,
            identity_seed_phrase: None,
            deploy_identity_pem: None,
            api_key: crate::config::Redacted("test".into()),
            smtp_relay_host: "127.0.0.1".into(),
            smtp_relay_port: 587,
            smtp_relay_username: String::new(),
            smtp_relay_password: crate::config::Redacted(String::new()),
            smtp_relay_tls: crate::config::SmtpRelayTls::StartTls,
            tls_cert_path: std::path::PathBuf::new(),
            tls_key_path: std::path::PathBuf::new(),
            dmarc_enforcement: true,
            dkim_private_key_path: None,
            dkim_selector: "default".into(),
            dkim_domain: "mail.example.com".into(),
        }
    }
}
