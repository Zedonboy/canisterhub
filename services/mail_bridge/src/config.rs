//! All runtime configuration comes from the environment - see README.md for
//! the full list, defaults, and the conventions this bridge assumes
//! (recipient-address routing, the `receive_mail` canister interface).

use candid::Principal;

/// Wraps a secret so `Config`'s derived `Debug` can't ever leak it via a
/// stray `{config:?}` in a log line - mirrors
/// `services/orchestrator/src/config.rs`'s `Redacted`.
#[derive(Clone)]
pub struct Redacted(pub String);

impl std::fmt::Debug for Redacted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

impl std::ops::Deref for Redacted {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpRelayTls {
    /// Connect in plaintext, then `STARTTLS` (RFC 3207) - port 587's
    /// convention, and the default virtually every transactional-email
    /// provider expects.
    StartTls,
    /// TLS from the very first byte, no `STARTTLS` command - port 465's
    /// convention (sometimes called "implicit TLS" or "SMTPS").
    Wrapper,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Address the inbound SMTP server listens on.
    pub smtp_bind_addr: String,

    /// Address the outbound HTTP API (`POST /send_mail`) listens on.
    pub http_bind_addr: String,

    /// Domain this bridge accepts inbound mail for - a RCPT TO whose domain
    /// doesn't match this is rejected rather than silently accepted and
    /// dropped (this bridge is not an open relay).
    pub mail_domain: String,

    /// Hard cap on one message's total DATA size, rejected mid-transfer if
    /// exceeded.
    pub max_message_bytes: usize,

    /// Replica URL the bridge's ic-agent talks to.
    pub ic_url: String,

    /// Whether `ic_url` is a local/test replica, whose root key isn't the
    /// well-known NNS one baked into ic-agent and must be fetched explicitly.
    /// Never set this for mainnet.
    pub ic_local: bool,

    /// BIP-39 seed phrase to derive this bridge's identity from, the same way
    /// `dfx identity new` does - see `ic::agent::identity_from_seed_phrase`.
    /// Takes priority over `deploy_identity_pem` when both are set. This
    /// identity's principal is what a `receive_mail` implementation should
    /// check `msg_caller()` against, to only accept mail this bridge forwarded.
    pub identity_seed_phrase: Option<Redacted>,

    /// PEM file (Secp256k1 or Ed25519) used as this bridge's identity if
    /// `identity_seed_phrase` isn't set.
    pub deploy_identity_pem: Option<std::path::PathBuf>,

    /// Bearer token `POST /send_mail` requires - a canister wanting to send
    /// mail includes this as `Authorization: Bearer <key>` on its HTTPS
    /// outcall. Shared-secret auth, not per-caller: see README.md's
    /// "Authenticating outbound requests" for the tradeoff and how to swap in
    /// something stronger.
    pub api_key: Redacted,

    /// Upstream SMTP relay outbound mail is actually sent through - this
    /// bridge does not attempt direct-to-recipient delivery.
    pub smtp_relay_host: String,
    pub smtp_relay_port: u16,
    pub smtp_relay_username: String,
    pub smtp_relay_password: Redacted,
    /// How to negotiate TLS with the relay - `"starttls"` (plaintext
    /// connect, then upgrade; the near-universal convention on port 587,
    /// which is also this config's own default port) or `"wrapper"`
    /// (TLS from the very first byte; the convention on port 465). Getting
    /// this wrong doesn't degrade gracefully - the relay sees either raw TLS
    /// bytes where it expected `EHLO`, or vice versa - so it's explicit
    /// rather than guessed from the port number.
    pub smtp_relay_tls: SmtpRelayTls,

    /// TLS certificate chain and private key `STARTTLS` upgrades a connection
    /// with. Required: a mail server without `STARTTLS` fails modern
    /// deliverability/compliance expectations - see README.md if you only
    /// need this for local testing (a self-signed cert is enough there).
    pub tls_cert_path: std::path::PathBuf,
    pub tls_key_path: std::path::PathBuf,

    /// If `true` (the default), a message whose sending domain publishes a
    /// DMARC `p=reject` policy and fails DMARC is rejected outright rather
    /// than forwarded - see `mail::auth::VerificationOutcome::should_reject`.
    pub dmarc_enforcement: bool,

    /// DKIM signing key for outbound mail (`POST /send_mail`) - optional.
    /// Unsigned outbound mail is more likely to be spam-filtered by the
    /// receiving side, but this bridge still works without it. RSA only
    /// (PKCS1, PKCS8, or SEC1 PEM, auto-detected) - see README.md's
    /// limitations for why not Ed25519.
    pub dkim_private_key_path: Option<std::path::PathBuf>,
    pub dkim_selector: String,
    /// Domain to sign outbound DKIM as - defaults to `mail_domain` (only
    /// worth overriding if this bridge sends mail "from" a different domain
    /// than the one it receives mail for).
    pub dkim_domain: String,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let mail_domain = std::env::var("MAIL_DOMAIN")
            .map_err(|_| anyhow::anyhow!("MAIL_DOMAIN must be set (the domain this bridge accepts inbound mail for)"))?;

        let max_message_bytes: usize = env_or("MAX_MESSAGE_BYTES", "26214400" /* 25 MiB, a common inbound cap */)
            .parse()
            .map_err(|_| anyhow::anyhow!("MAX_MESSAGE_BYTES must be a usize"))?;

        let ic_local: bool = env_or("IC_LOCAL", "false")
            .parse()
            .map_err(|_| anyhow::anyhow!("IC_LOCAL must be \"true\" or \"false\""))?;

        let identity_seed_phrase = std::env::var("IDENTITY_SEED_PHRASE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(Redacted);
        let deploy_identity_pem = std::env::var("DEPLOY_IDENTITY_PEM").ok().map(std::path::PathBuf::from);
        if identity_seed_phrase.is_none() && deploy_identity_pem.is_none() {
            anyhow::bail!("one of IDENTITY_SEED_PHRASE or DEPLOY_IDENTITY_PEM must be set");
        }

        let api_key = std::env::var("MAIL_BRIDGE_API_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(Redacted)
            .ok_or_else(|| anyhow::anyhow!("MAIL_BRIDGE_API_KEY must be set (the bearer token POST /send_mail requires)"))?;

        let smtp_relay_host = std::env::var("SMTP_RELAY_HOST")
            .map_err(|_| anyhow::anyhow!("SMTP_RELAY_HOST must be set (the upstream relay outbound mail is sent through)"))?;
        let smtp_relay_port: u16 = env_or("SMTP_RELAY_PORT", "587")
            .parse()
            .map_err(|_| anyhow::anyhow!("SMTP_RELAY_PORT must be a u16"))?;
        let smtp_relay_username = std::env::var("SMTP_RELAY_USERNAME").unwrap_or_default();
        let smtp_relay_password = Redacted(std::env::var("SMTP_RELAY_PASSWORD").unwrap_or_default());
        let smtp_relay_tls = match env_or("SMTP_RELAY_TLS", "starttls").to_ascii_lowercase().as_str() {
            "starttls" => SmtpRelayTls::StartTls,
            "wrapper" => SmtpRelayTls::Wrapper,
            other => anyhow::bail!("SMTP_RELAY_TLS must be \"starttls\" or \"wrapper\", got {other:?}"),
        };

        let tls_cert_path = std::env::var("TLS_CERT_PATH")
            .map(std::path::PathBuf::from)
            .map_err(|_| anyhow::anyhow!("TLS_CERT_PATH must be set (STARTTLS requires a certificate - see README.md)"))?;
        let tls_key_path = std::env::var("TLS_KEY_PATH")
            .map(std::path::PathBuf::from)
            .map_err(|_| anyhow::anyhow!("TLS_KEY_PATH must be set (STARTTLS requires a private key - see README.md)"))?;

        let dmarc_enforcement: bool = env_or("DMARC_ENFORCEMENT", "true")
            .parse()
            .map_err(|_| anyhow::anyhow!("DMARC_ENFORCEMENT must be \"true\" or \"false\""))?;

        let dkim_private_key_path = std::env::var("DKIM_PRIVATE_KEY_PATH").ok().map(std::path::PathBuf::from);
        let dkim_selector = env_or("DKIM_SELECTOR", "default");
        let dkim_domain = std::env::var("DKIM_DOMAIN").unwrap_or_else(|_| mail_domain.clone());

        Ok(Self {
            smtp_bind_addr: env_or("SMTP_BIND_ADDR", "0.0.0.0:2525"),
            http_bind_addr: env_or("HTTP_BIND_ADDR", "0.0.0.0:8788"),
            mail_domain,
            max_message_bytes,
            ic_url: env_or("IC_URL", "https://ic0.app"),
            ic_local,
            identity_seed_phrase,
            deploy_identity_pem,
            api_key,
            smtp_relay_host,
            smtp_relay_port,
            smtp_relay_username,
            smtp_relay_password,
            smtp_relay_tls,
            tls_cert_path,
            tls_key_path,
            dmarc_enforcement,
            dkim_private_key_path,
            dkim_selector,
            dkim_domain,
        })
    }
}

/// Parses a mailbox's local-part as a canister principal - see README.md's
/// "Inbound routing" section for why the address itself *is* the routing key,
/// with no separate alias table: `<principal-text>@MAIL_DOMAIN`.
pub fn parse_recipient_principal(local_part: &str) -> Result<Principal, String> {
    Principal::from_text(local_part).map_err(|e| format!("'{local_part}' is not a valid canister principal: {e}"))
}
