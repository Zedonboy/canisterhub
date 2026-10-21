//! The candid shape delivered to a canister's `receive_mail` method, and
//! parsing a raw RFC 5322 message (as received over SMTP's DATA command)
//! into it via `mail-parser`. See README.md's "The `receive_mail` interface"
//! section for the full candid type and what a canister implementing it
//! should check.

use crate::mail::auth::{AuthResult, VerificationOutcome};
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct IncomingMail {
    /// The SMTP envelope sender (`MAIL FROM`) - not necessarily the same as
    /// `from` (the message's own `From:` header), which is attacker-controlled
    /// content and easily spoofed without SPF/DKIM/DMARC verification (not
    /// implemented here - see README.md's limitations).
    pub envelope_from: String,
    /// The SMTP envelope recipients (`RCPT TO`) this message was delivered
    /// for - always includes the recipient this particular `receive_mail`
    /// call is addressed to, but may include others if the sender listed
    /// multiple recipients on one message.
    pub envelope_to: Vec<String>,
    /// The message's own `From:` header, as written (display name + address).
    pub from: String,
    /// The message's own `To:` header addresses.
    pub to: Vec<String>,
    pub subject: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    /// Every header on the message, in order, as `(name, value)` pairs -
    /// including ones already broken out above, for a canister that needs
    /// something this type doesn't surface directly (e.g. `Message-ID`,
    /// `In-Reply-To`).
    pub headers: Vec<(String, String)>,
    /// Nanoseconds since the Unix epoch, matching `ic_cdk::api::time()`'s
    /// convention - when this bridge received the message, not necessarily
    /// when it was sent.
    pub received_at: u64,
    /// SPF result for the envelope sender's domain.
    pub spf: AuthResult,
    /// DKIM result - `Pass` if at least one signature on the message verified;
    /// otherwise the first signature's own result, or `None` if the message
    /// carried no DKIM signature at all.
    pub dkim: AuthResult,
    /// DMARC result (SPF/DKIM alignment against the `From:` domain's policy).
    /// A message whose sending domain publishes `p=reject` and fails DMARC is
    /// rejected by this bridge before it ever reaches here - see
    /// `mail::auth::VerificationOutcome::should_reject`.
    pub dmarc: AuthResult,
    /// Whether this message was received over a `STARTTLS`-upgraded
    /// connection.
    pub tls: bool,
}

impl IncomingMail {
    pub fn with_auth(mut self, outcome: &VerificationOutcome, tls: bool) -> Self {
        self.spf = outcome.spf;
        self.dkim = outcome.dkim;
        self.dmarc = outcome.dmarc;
        self.tls = tls;
        self
    }
}

/// Parses a raw RFC 5322 message. `envelope_from`/`envelope_to` come from the
/// SMTP session (`MAIL FROM`/`RCPT TO`), not the message itself.
pub fn parse_message(raw: &[u8], envelope_from: &str, envelope_to: &[String]) -> anyhow::Result<IncomingMail> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| anyhow::anyhow!("could not parse message"))?;

    let from = message
        .from()
        .and_then(|addr| addr.first())
        .map(format_address)
        .unwrap_or_else(|| envelope_from.to_string());

    let to = message
        .to()
        .map(|addr| addr.iter().map(format_address).collect())
        .unwrap_or_default();

    let headers = message
        .headers()
        .iter()
        .filter_map(|h| {
            let name = h.name().to_string();
            let value = h.value().as_text().map(str::to_string)?;
            Some((name, value))
        })
        .collect();

    let received_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;

    Ok(IncomingMail {
        envelope_from: envelope_from.to_string(),
        envelope_to: envelope_to.to_vec(),
        from,
        to,
        subject: message.subject().unwrap_or_default().to_string(),
        text_body: message.body_text(0).map(|c| c.to_string()),
        html_body: message.body_html(0).map(|c| c.to_string()),
        headers,
        received_at,
        // Filled in by `with_auth` once verification has run - parsing and
        // verification are separate steps (server.rs's `handle_message`
        // needs the parsed message before it can compute DKIM/DMARC).
        spf: AuthResult::None,
        dkim: AuthResult::None,
        dmarc: AuthResult::None,
        tls: false,
    })
}

fn format_address(addr: &mail_parser::Addr) -> String {
    match (addr.name(), addr.address()) {
        (Some(name), Some(email)) => format!("{name} <{email}>"),
        (None, Some(email)) => email.to_string(),
        (Some(name), None) => name.to_string(),
        (None, None) => String::new(),
    }
}
