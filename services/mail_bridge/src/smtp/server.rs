//! An ESMTP server implementing enough of RFC 5321 to receive a message and
//! hand it off (`EHLO`/`HELO`, `MAIL FROM`, `RCPT TO`, `DATA`, `RSET`, `NOOP`,
//! `QUIT`), plus `STARTTLS` (RFC 3207) and SPF/DKIM/DMARC verification (see
//! `mail::auth`). No `AUTH`, no pipelining/`BDAT` chunking - see README.md's
//! "Inbound SMTP server" section for what that means for how this is meant to
//! be deployed.
//!
//! Hand-rolled rather than built on an SMTP server crate: the command grammar
//! this subset needs is small and stable, and the two actively-maintained
//! options at the time this was written were either synchronous
//! (`mailin-embedded`, awkward to fit into a tokio/axum service) or an
//! undocumented low-level parser (`smtp-proto`) that would have meant working
//! from its source rather than sourcing a genuine understanding of its API.

use crate::config::{parse_recipient_principal, Config};
use crate::mail::auth::VerificationOutcome;
use crate::mail::message;
use crate::smtp::session::{AcceptedRecipient, Session};
use crate::state::AppState;
use std::net::SocketAddr;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// RFC 5321 §4.5.3.1.6 recommends 1000 octets per command line; this is a
/// generous multiple of that, just to reject a client streaming an unbounded
/// line without ever sending CRLF rather than let it exhaust memory.
const MAX_LINE_BYTES: usize = 8 * 1024;

pub async fn run(state: AppState) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&state.config.smtp_bind_addr).await?;
    tracing::info!(addr = %state.config.smtp_bind_addr, "SMTP server listening");

    loop {
        let (socket, peer) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            tracing::info!(%peer, "SMTP connection accepted");
            if let Err(e) = handle_connection(socket, peer, &state).await {
                tracing::warn!(%peer, error = %e, "SMTP connection ended with an error");
            }
        });
    }
}

/// What one plaintext-or-TLS command loop iteration ended with.
enum SessionOutcome<S> {
    /// `QUIT`, or the client disconnected.
    Done,
    /// `STARTTLS` was accepted - `raw` is the connection's I/O object handed
    /// back so the caller can perform the TLS handshake on it and start a new
    /// command loop over the resulting `TlsStream`.
    StartTls(S),
}

async fn handle_connection(socket: TcpStream, peer: SocketAddr, state: &AppState) -> anyhow::Result<()> {
    let mut session = Session::default();
    match run_session(socket, peer, state, &mut session, false).await? {
        SessionOutcome::Done => Ok(()),
        SessionOutcome::StartTls(raw) => {
            let tls_stream = state.tls_acceptor.accept(raw).await?;
            tracing::info!(%peer, "STARTTLS handshake complete");
            // RFC 3207 §4.2: all prior session state, including any
            // completed EHLO, is discarded - the client must EHLO again.
            let mut session = Session::default();
            run_session(tls_stream, peer, state, &mut session, true).await?;
            Ok(())
        }
    }
}

async fn run_session<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    peer: SocketAddr,
    state: &AppState,
    session: &mut Session,
    is_tls: bool,
) -> anyhow::Result<SessionOutcome<S>> {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);

    // RFC 3207 §4.2: after STARTTLS the server does NOT send a fresh greeting
    // - the client goes straight to EHLO on the new TLS session. `is_tls` is
    // exactly the "this is the post-STARTTLS invocation" flag already, so it
    // doubles as this one too.
    if !is_tls {
        reply(&mut writer, 220, &format!("{} ESMTP mail_bridge ready", state.config.mail_domain)).await?;
    }

    loop {
        let Some(line) = read_line(&mut reader).await? else {
            return Ok(SessionOutcome::Done); // client disconnected
        };
        let line = line.trim_end();
        let (verb, rest) = split_command(line);

        match verb.to_ascii_uppercase().as_str() {
            "EHLO" | "HELO" => {
                session.helo = Some(rest.to_string());
                session.reset_transaction();
                let mut out = format!("250-{}\r\n", state.config.mail_domain);
                if !is_tls {
                    out.push_str("250-STARTTLS\r\n");
                }
                // Safe to advertise unconditionally: the command loop below
                // already reads and processes one line at a time in strict
                // arrival order regardless of whether a client waits for each
                // response before sending the next command, so there's no
                // extra batching work needed on this end to support a client
                // pipelining MAIL/RCPT/DATA together (RFC 2920).
                out.push_str("250-PIPELINING\r\n");
                out.push_str(&format!("250 SIZE {}\r\n", state.config.max_message_bytes));
                writer.write_all(out.as_bytes()).await?;
            }

            "STARTTLS" => {
                if is_tls {
                    reply(&mut writer, 503, "Connection already using TLS").await?;
                    continue;
                }
                reply(&mut writer, 220, "Go ahead").await?;
                let read_half = reader.into_inner();
                let raw = read_half.unsplit(writer);
                return Ok(SessionOutcome::StartTls(raw));
            }

            "MAIL" => {
                if session.helo.is_none() {
                    reply(&mut writer, 503, "Bad sequence of commands - send EHLO/HELO first").await?;
                    continue;
                }
                match parse_path_argument("FROM:", rest) {
                    Some(addr) => {
                        session.reset_transaction();
                        session.mail_from = Some(addr);
                        reply(&mut writer, 250, "OK").await?;
                    }
                    None => reply(&mut writer, 501, "Syntax: MAIL FROM:<address>").await?,
                }
            }

            "RCPT" => {
                if session.mail_from.is_none() {
                    reply(&mut writer, 503, "Bad sequence of commands - send MAIL FROM first").await?;
                    continue;
                }
                match parse_path_argument("TO:", rest) {
                    Some(addr) => match resolve_recipient(&state.config, &addr) {
                        Ok(canister_id) => {
                            session.rcpt_to.push(AcceptedRecipient { address: addr, canister_id });
                            reply(&mut writer, 250, "OK").await?;
                        }
                        Err(e) => reply(&mut writer, 550, &format!("No such recipient: {e}")).await?,
                    },
                    None => reply(&mut writer, 501, "Syntax: RCPT TO:<address>").await?,
                }
            }

            "DATA" => {
                if session.rcpt_to.is_empty() {
                    reply(&mut writer, 503, "Bad sequence of commands - need at least one accepted RCPT TO").await?;
                    continue;
                }
                reply(&mut writer, 354, "End data with <CR><LF>.<CR><LF>").await?;
                match read_data(&mut reader, state.config.max_message_bytes).await? {
                    Some(raw) => {
                        let helo = session.helo.clone().unwrap_or_default();
                        let mail_from = session.mail_from.clone().unwrap_or_default();
                        let outcome = state.verifier.verify(peer.ip(), &helo, &mail_from, &state.config.mail_domain, &raw).await;

                        if state.config.dmarc_enforcement && outcome.should_reject() {
                            tracing::warn!(%peer, from = %mail_from, "rejecting message - DMARC p=reject and DMARC failed");
                            reply(&mut writer, 550, "Message rejected: fails DMARC and sending domain requests p=reject").await?;
                        } else {
                            handle_message(state, session, &raw, &outcome, is_tls).await;
                            reply(&mut writer, 250, "OK: message accepted").await?;
                        }
                    }
                    None => reply(&mut writer, 552, "Message exceeded the size limit").await?,
                }
                session.reset_transaction();
            }

            "RSET" => {
                session.reset_transaction();
                reply(&mut writer, 250, "OK").await?;
            }

            "NOOP" => reply(&mut writer, 250, "OK").await?,

            "QUIT" => {
                reply(&mut writer, 221, "Bye").await?;
                return Ok(SessionOutcome::Done);
            }

            _ => reply(&mut writer, 500, "Command not recognized").await?,
        }
    }
}

/// Forwards the message this session just received to every accepted
/// recipient's canister, independently - one canister rejecting or erroring
/// doesn't affect delivery to the others. Failures are logged, not bounced
/// back to the sender: this bridge doesn't generate DSNs (see README.md's
/// limitations), and the `250` response was already committed to once `DATA`
/// was accepted, per RFC 5321's own model of accept-then-attempt.
async fn handle_message(state: &AppState, session: &Session, raw: &[u8], outcome: &VerificationOutcome, is_tls: bool) {
    let envelope_from = session.mail_from.clone().unwrap_or_default();
    let envelope_to: Vec<String> = session.rcpt_to.iter().map(|r| r.address.clone()).collect();

    let mail = match message::parse_message(raw, &envelope_from, &envelope_to) {
        Ok(mail) => mail.with_auth(outcome, is_tls),
        Err(e) => {
            tracing::warn!(error = %e, "failed to parse an accepted message - dropping it");
            return;
        }
    };

    let mut failures = Vec::new();
    for recipient in &session.rcpt_to {
        match crate::ic::canister::receive_mail(&state.agent, recipient.canister_id, &mail).await {
            Ok(()) => tracing::info!(to = %recipient.address, canister_id = %recipient.canister_id, "delivered to canister"),
            Err(e) => {
                tracing::warn!(to = %recipient.address, canister_id = %recipient.canister_id, error = %e, "failed to deliver to canister");
                failures.push(crate::mail::dsn::DeliveryFailure { recipient: recipient.address.clone(), error: e.to_string() });
            }
        }
    }

    crate::mail::dsn::maybe_send(&state.config, &envelope_from, &mail.subject, &failures).await;
}

/// `local-part@domain` -> the target canister, provided `domain` matches
/// `config.mail_domain` and `local-part` is itself a valid principal - see
/// README.md's "Inbound routing" section for why the address doubles as the
/// routing key.
fn resolve_recipient(config: &Config, address: &str) -> Result<candid::Principal, String> {
    let (local_part, domain) = address.rsplit_once('@').ok_or_else(|| format!("'{address}' is not a valid email address"))?;
    if !domain.eq_ignore_ascii_case(&config.mail_domain) {
        return Err(format!("this bridge does not accept mail for domain '{domain}'"));
    }
    parse_recipient_principal(local_part)
}

/// Extracts the `<...>` path argument from `MAIL FROM:<addr> ...` /
/// `RCPT TO:<addr> ...`, tolerating the angle brackets being omitted (some
/// clients send bare addresses) and trailing ESMTP parameters
/// (`SIZE=...`, etc, which this bridge otherwise ignores).
fn parse_path_argument(prefix: &str, rest: &str) -> Option<String> {
    let rest = rest.trim();
    let after_prefix = if rest.len() >= prefix.len() && rest[..prefix.len()].eq_ignore_ascii_case(prefix) {
        rest[prefix.len()..].trim_start()
    } else {
        return None;
    };

    let path = if let Some(stripped) = after_prefix.strip_prefix('<') {
        stripped.split('>').next()?.to_string()
    } else {
        after_prefix.split_whitespace().next()?.to_string()
    };

    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Splits `"VERB rest of line"` into `("VERB", "rest of line")`.
fn split_command(line: &str) -> (&str, &str) {
    match line.split_once(' ') {
        Some((verb, rest)) => (verb, rest),
        None => (line, ""),
    }
}

async fn reply<W: AsyncWriteExt + Unpin>(writer: &mut W, code: u16, text: &str) -> anyhow::Result<()> {
    writer.write_all(format!("{code} {text}\r\n").as_bytes()).await?;
    Ok(())
}

/// Reads one CRLF (or bare LF)-terminated line, capped at `MAX_LINE_BYTES`.
/// `Ok(None)` means the client disconnected cleanly.
async fn read_line<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> anyhow::Result<Option<String>> {
    let mut buf = Vec::new();
    let mut limited = reader.take(MAX_LINE_BYTES as u64);
    let read = limited.read_until(b'\n', &mut buf).await?;
    if read == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') {
        anyhow::bail!("command line exceeded {MAX_LINE_BYTES} bytes without a terminator");
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Reads a `DATA` body until a line consisting of a lone `.`, undoing
/// RFC 5321 §4.5.2 dot-stuffing (a leading `.` on any other line is escaping,
/// not content, and gets one `.` removed). Returns `Ok(None)` if
/// `max_bytes` is exceeded partway through - the caller still needs to keep
/// reading to resynchronize with the client's next command, since dropping
/// the connection mid-DATA would leave it stuck.
async fn read_data<R: AsyncBufReadExt + Unpin>(reader: &mut R, max_bytes: usize) -> anyhow::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    let mut over_limit = false;

    loop {
        let Some(line) = read_line(reader).await? else {
            anyhow::bail!("client disconnected mid-DATA");
        };
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "." {
            break;
        }

        if !over_limit {
            let content = trimmed.strip_prefix('.').unwrap_or(trimmed);
            if out.len() + content.len() + 2 > max_bytes {
                over_limit = true;
            } else {
                out.extend_from_slice(content.as_bytes());
                out.extend_from_slice(b"\r\n");
            }
        }
    }

    Ok(if over_limit { None } else { Some(out) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn split_command_separates_verb_and_rest() {
        assert_eq!(split_command("MAIL FROM:<a@b.com>"), ("MAIL", "FROM:<a@b.com>"));
        assert_eq!(split_command("QUIT"), ("QUIT", ""));
        assert_eq!(split_command("EHLO example.com"), ("EHLO", "example.com"));
    }

    #[test]
    fn parse_path_argument_handles_angle_brackets() {
        assert_eq!(parse_path_argument("FROM:", "FROM:<a@b.com>"), Some("a@b.com".to_string()));
        assert_eq!(parse_path_argument("TO:", "TO:<a@b.com>"), Some("a@b.com".to_string()));
    }

    #[test]
    fn parse_path_argument_handles_bare_address_and_trailing_params() {
        assert_eq!(parse_path_argument("FROM:", "FROM:a@b.com"), Some("a@b.com".to_string()));
        assert_eq!(parse_path_argument("FROM:", "FROM:<a@b.com> SIZE=1024"), Some("a@b.com".to_string()));
    }

    #[test]
    fn parse_path_argument_is_case_insensitive_and_rejects_wrong_prefix() {
        assert_eq!(parse_path_argument("FROM:", "from:<a@b.com>"), Some("a@b.com".to_string()));
        assert_eq!(parse_path_argument("FROM:", "TO:<a@b.com>"), None);
    }

    #[test]
    fn parse_path_argument_rejects_empty_address() {
        assert_eq!(parse_path_argument("FROM:", "FROM:<>"), None);
    }

    #[test]
    fn resolve_recipient_requires_matching_domain_and_valid_principal() {
        let config = test_config();
        assert!(resolve_recipient(&config, &format!("2vxsx-fae@{}", config.mail_domain)).is_ok());
        assert!(resolve_recipient(&config, "2vxsx-fae@wrong-domain.com").is_err());
        assert!(resolve_recipient(&config, &format!("not-a-principal@{}", config.mail_domain)).is_err());
        assert!(resolve_recipient(&config, "not-an-email").is_err());
    }

    fn test_config() -> Config {
        // SAFETY (of the test, not the process): these env vars are only read
        // once, synchronously, by Config::from_env - no concurrent test in
        // this binary also mutates the environment.
        std::env::set_var("MAIL_DOMAIN", "mail.example.com");
        std::env::set_var("IDENTITY_SEED_PHRASE", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
        std::env::set_var("MAIL_BRIDGE_API_KEY", "test-key");
        std::env::set_var("SMTP_RELAY_HOST", "localhost");
        std::env::set_var("TLS_CERT_PATH", "/dev/null");
        std::env::set_var("TLS_KEY_PATH", "/dev/null");
        Config::from_env().unwrap()
    }

    #[tokio::test]
    async fn read_data_undoes_dot_stuffing_and_stops_at_lone_dot() {
        let input = b"Subject: hi\r\n\r\n..this line started with a dot\r\nplain line\r\n.\r\nSHOULD NOT BE READ\r\n";
        let mut reader = BufReader::new(&input[..]);
        let data = read_data(&mut reader, 1_000_000).await.unwrap().unwrap();
        let text = String::from_utf8(data).unwrap();
        assert!(text.contains(".this line started with a dot"));
        assert!(text.contains("plain line"));
        assert!(!text.contains("SHOULD NOT BE READ"));
    }

    #[tokio::test]
    async fn read_data_reports_over_limit() {
        let input = b"a very long line that exceeds the tiny limit\r\n.\r\n";
        let mut reader = BufReader::new(&input[..]);
        let data = read_data(&mut reader, 4).await.unwrap();
        assert!(data.is_none());
    }
}
