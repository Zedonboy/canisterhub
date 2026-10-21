//! Delivery Status Notifications (RFC 3464): when forwarding to a canister
//! fails after `DATA` already returned `250` (see `smtp::server::handle_message`),
//! the original sender otherwise has no way to find out - this bounces a
//! report back to them instead of only logging the failure.

use crate::config::Config;
use crate::outbound::relay;
use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, Message, MultiPart, SinglePart};

pub struct DeliveryFailure {
    pub recipient: String,
    pub error: String,
}

/// Sends a DSN to `envelope_from` if `failures` is non-empty - a no-op
/// (logged, not propagated) if the DSN itself can't be built or sent, since a
/// failure to report a failure shouldn't cascade.
///
/// Does nothing if `envelope_from` is empty (`MAIL FROM:<>`, the standard
/// "null return path" used by bounces and other DSNs themselves): RFC 5321
/// §4.5.5 requires never generating a DSN in response to one, since a bounce
/// with an ordinary reverse-path could otherwise trigger the systems it was
/// forwarded through to bounce it right back - an infinite loop.
pub async fn maybe_send(config: &Config, envelope_from: &str, subject: &str, failures: &[DeliveryFailure]) {
    if envelope_from.trim().is_empty() || failures.is_empty() {
        return;
    }
    if let Err(e) = send(config, envelope_from, subject, failures).await {
        tracing::warn!(error = %e, to = %envelope_from, "failed to send a delivery status notification");
    }
}

async fn send(config: &Config, envelope_from: &str, subject: &str, failures: &[DeliveryFailure]) -> anyhow::Result<()> {
    let to: Mailbox = envelope_from.parse().map_err(|e| anyhow::anyhow!("original sender '{envelope_from}' is not a valid address: {e}"))?;
    let from: Mailbox = format!("Mail Delivery System <mailer-daemon@{}>", config.mail_domain)
        .parse()
        .expect("mail_domain was already validated to build a valid address elsewhere");

    let human = human_readable_part(&config.mail_domain, subject, failures);
    let machine = machine_readable_part(&config.mail_domain, failures);

    let mut report = MultiPart::mixed().singlepart(SinglePart::plain(human)).singlepart(
        SinglePart::builder()
            .header(ContentType::parse("message/delivery-status").expect("static content type string is valid"))
            .body(machine),
    );
    // `MultiPart::mixed()` picks its own boundary and sets `Content-Type:
    // multipart/mixed`; RFC 3464 requires `multipart/report` specifically
    // (with a `report-type` parameter), which lettre has no built-in
    // constructor for - reuse the boundary it already generated and override
    // just the header.
    let boundary = report.boundary();
    report
        .headers_mut()
        .set(ContentType::parse(&format!("multipart/report; report-type=delivery-status; boundary=\"{boundary}\"")).expect("boundary is alphanumeric, always a valid content-type parameter"));

    let message = Message::builder()
        .from(from)
        .to(to.clone())
        .subject(format!("Delivery Status Notification (Failure): {subject}"))
        .multipart(report)?;

    let raw = relay::sign_if_configured(config, &message.formatted());
    // Null reverse-path (`MAIL FROM:<>`) - see `maybe_send`'s doc comment on
    // why a DSN must never itself be bounce-able.
    let envelope = Envelope::new(None, vec![to.email])?;
    relay::send_via_relay(config, &envelope, &raw).await
}

fn human_readable_part(mail_domain: &str, subject: &str, failures: &[DeliveryFailure]) -> String {
    let mut out = format!(
        "This is an automated message from {mail_domain}.\r\n\r\n\
         Delivery failed for the following recipient(s) of your message\r\n\
         \"{subject}\":\r\n\r\n"
    );
    for f in failures {
        out.push_str(&format!("  {} - {}\r\n", f.recipient, f.error));
    }
    out
}

/// A `message/delivery-status` body per RFC 3464 §2.2/§2.3: one
/// per-message `Reporting-MTA` field, followed by one per-recipient block.
fn machine_readable_part(mail_domain: &str, failures: &[DeliveryFailure]) -> String {
    let mut out = format!("Reporting-MTA: dns;{mail_domain}\r\n");
    for f in failures {
        out.push_str(&format!(
            "\r\nFinal-Recipient: rfc822;{}\r\nAction: failed\r\nStatus: 5.0.0\r\nDiagnostic-Code: smtp; {}\r\n",
            f.recipient, f.error
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_failures() -> Vec<DeliveryFailure> {
        vec![
            DeliveryFailure { recipient: "abc-def@mail.example.com".into(), error: "canister_not_found".into() },
            DeliveryFailure { recipient: "ghi-jkl@mail.example.com".into(), error: "canister trapped".into() },
        ]
    }

    #[test]
    fn human_readable_part_names_domain_subject_and_every_failed_recipient() {
        let out = human_readable_part("mail.example.com", "Hello", &sample_failures());
        assert!(out.contains("mail.example.com"));
        assert!(out.contains("\"Hello\""));
        assert!(out.contains("abc-def@mail.example.com - canister_not_found"));
        assert!(out.contains("ghi-jkl@mail.example.com - canister trapped"));
    }

    #[test]
    fn machine_readable_part_matches_rfc3464_field_names() {
        let out = machine_readable_part("mail.example.com", &sample_failures());
        assert!(out.starts_with("Reporting-MTA: dns;mail.example.com\r\n"));
        // One `Final-Recipient`/`Action`/`Status`/`Diagnostic-Code` block per
        // failed recipient, per RFC 3464 §2.3.
        assert_eq!(out.matches("Final-Recipient: rfc822;").count(), 2);
        assert!(out.contains("Final-Recipient: rfc822;abc-def@mail.example.com\r\nAction: failed\r\nStatus: 5.0.0\r\nDiagnostic-Code: smtp; canister_not_found\r\n"));
        assert!(out.contains("Final-Recipient: rfc822;ghi-jkl@mail.example.com\r\nAction: failed\r\nStatus: 5.0.0\r\nDiagnostic-Code: smtp; canister trapped\r\n"));
    }

    #[test]
    fn machine_readable_part_with_no_failures_has_only_the_reporting_mta_line() {
        let out = machine_readable_part("mail.example.com", &[]);
        assert_eq!(out, "Reporting-MTA: dns;mail.example.com\r\n");
    }
}
