//! SPF, DKIM, and DMARC verification of inbound mail, via
//! [`mail-auth`](https://github.com/stalwartlabs/mail-auth) (same author as
//! `mail-parser`). Each check is independent and best-effort: a DNS failure
//! or missing record shows up as `TempError`/`PermError`/`None` in the result
//! rather than aborting the whole message, since a `receive_mail`
//! implementation - not this bridge - is what should ultimately decide how
//! strict to be about any of these individually. The one exception is DMARC
//! `p=reject`, enforced here directly - see `enforce_dmarc` and
//! `smtp::server`'s use of it.

use candid::CandidType;
use mail_auth::dmarc::verify::DmarcParameters;
use mail_auth::dmarc::Policy as DmarcPolicy;
use mail_auth::spf::verify::SpfParameters;
use mail_auth::{DkimResult, DmarcOutput, DmarcResult, MessageAuthenticator, SpfOutput, SpfResult};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

/// A verification outcome, collapsed to the handful of states any of
/// SPF/DKIM/DMARC can produce - deliberately coarser than `mail-auth`'s own
/// per-check result types (which carry structured error detail this bridge
/// doesn't need to hand a canister), so the same candid type covers all three.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthResult {
    Pass,
    Fail,
    SoftFail,
    Neutral,
    /// No applicable policy record was published (e.g. no SPF/DKIM/DMARC
    /// record for the domain) - not itself suspicious, most domains don't
    /// publish all three.
    None,
    /// A transient problem (usually DNS) - retrying later might succeed.
    TempError,
    /// A permanent problem (a malformed record, for instance).
    PermError,
}

impl From<SpfResult> for AuthResult {
    fn from(result: SpfResult) -> Self {
        match result {
            SpfResult::Pass => AuthResult::Pass,
            SpfResult::Fail => AuthResult::Fail,
            SpfResult::SoftFail => AuthResult::SoftFail,
            SpfResult::Neutral => AuthResult::Neutral,
            SpfResult::None => AuthResult::None,
            SpfResult::TempError => AuthResult::TempError,
            SpfResult::PermError => AuthResult::PermError,
        }
    }
}

impl From<&DkimResult> for AuthResult {
    fn from(result: &DkimResult) -> Self {
        match result {
            DkimResult::Pass => AuthResult::Pass,
            DkimResult::Neutral(_) => AuthResult::Neutral,
            DkimResult::Fail(_) => AuthResult::Fail,
            DkimResult::PermError(_) => AuthResult::PermError,
            DkimResult::TempError(_) => AuthResult::TempError,
            DkimResult::None => AuthResult::None,
        }
    }
}

impl From<&DmarcResult> for AuthResult {
    fn from(result: &DmarcResult) -> Self {
        match result {
            DmarcResult::Pass => AuthResult::Pass,
            DmarcResult::Fail(_) => AuthResult::Fail,
            DmarcResult::TempError(_) => AuthResult::TempError,
            DmarcResult::PermError(_) => AuthResult::PermError,
            DmarcResult::None => AuthResult::None,
        }
    }
}

pub struct VerificationOutcome {
    pub spf: AuthResult,
    pub dkim: AuthResult,
    pub dmarc: AuthResult,
    /// The sending domain's own published enforcement preference (`p=` in its
    /// DMARC record, or `Policy::None` if it has no record at all - this is
    /// `mail-auth`'s own convention). `None` here specifically means DMARC
    /// was never evaluated at all (the message itself failed to parse).
    pub dmarc_policy: Option<DmarcPolicy>,
}

impl VerificationOutcome {
    /// Whether this message should be rejected outright per the sending
    /// domain's own stated DMARC policy - `p=reject` and DMARC failed. This
    /// is the one check this bridge enforces itself rather than leaving
    /// entirely to `receive_mail`: an MTA choosing to accept mail a domain
    /// has explicitly asked to be rejected isn't a policy call worth
    /// defaulting to.
    pub fn should_reject(&self) -> bool {
        self.dmarc == AuthResult::Fail && self.dmarc_policy == Some(DmarcPolicy::Reject)
    }
}

pub struct Verifier(MessageAuthenticator);

impl Verifier {
    /// Uses the host's configured system resolver (`/etc/resolv.conf`) -
    /// works out of the box in essentially any deployment (bare metal,
    /// Docker with its default embedded resolver, Kubernetes) without this
    /// bridge needing its own DNS-over-TLS setup.
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self(MessageAuthenticator::new_system_conf()?))
    }

    /// Runs SPF, DKIM, and DMARC checks for one message.
    ///
    /// - `client_ip` / `helo_domain`: the connecting SMTP client's address and
    ///   its `EHLO`/`HELO` argument - both feed SPF.
    /// - `mail_from`: the envelope sender (`MAIL FROM`) - SPF checks this
    ///   domain; DMARC checks it for RFC 5321/5322 alignment.
    /// - `our_domain`: this bridge's own domain (`MAIL_DOMAIN`), used only for
    ///   macro expansion in SPF records that reference the *validating* host.
    /// - `raw_message`: the exact bytes `DATA` delivered, for DKIM/DMARC.
    pub async fn verify(&self, client_ip: IpAddr, helo_domain: &str, mail_from: &str, our_domain: &str, raw_message: &[u8]) -> VerificationOutcome {
        let spf_output: SpfOutput = self
            .0
            .verify_spf(SpfParameters::verify_mail_from(client_ip, helo_domain, our_domain, mail_from))
            .await;
        let spf_result = spf_output.result();

        let dkim_result: AuthResult = match mail_auth::AuthenticatedMessage::parse(raw_message) {
            Some(authenticated_message) => {
                let dkim_outputs = self.0.verify_dkim(&authenticated_message).await;
                let dmarc_domain = mail_from.rsplit_once('@').map(|(_, d)| d).unwrap_or(mail_from);
                let dmarc_output: DmarcOutput = self
                    .0
                    .verify_dmarc(DmarcParameters::new(&authenticated_message, &dkim_outputs, dmarc_domain, &spf_output))
                    .await;

                let dkim_pass = dkim_outputs.iter().any(|o| o.result() == &DkimResult::Pass);
                let dkim_summary = if dkim_pass {
                    AuthResult::Pass
                } else {
                    dkim_outputs.first().map(|o| AuthResult::from(o.result())).unwrap_or(AuthResult::None)
                };

                let dmarc_pass = *dmarc_output.dkim_result() == DmarcResult::Pass || *dmarc_output.spf_result() == DmarcResult::Pass;
                let dmarc_summary = if dmarc_pass {
                    AuthResult::Pass
                } else if *dmarc_output.dkim_result() != DmarcResult::None {
                    AuthResult::from(dmarc_output.dkim_result())
                } else {
                    AuthResult::from(dmarc_output.spf_result())
                };

                return VerificationOutcome {
                    spf: AuthResult::from(spf_result),
                    dkim: dkim_summary,
                    dmarc: dmarc_summary,
                    dmarc_policy: Some(dmarc_output.policy()),
                };
            }
            None => AuthResult::PermError,
        };

        VerificationOutcome {
            spf: AuthResult::from(spf_result),
            dkim: dkim_result,
            dmarc: AuthResult::None,
            dmarc_policy: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spf_result_maps_every_variant() {
        assert_eq!(AuthResult::from(SpfResult::Pass), AuthResult::Pass);
        assert_eq!(AuthResult::from(SpfResult::Fail), AuthResult::Fail);
        assert_eq!(AuthResult::from(SpfResult::SoftFail), AuthResult::SoftFail);
        assert_eq!(AuthResult::from(SpfResult::Neutral), AuthResult::Neutral);
        assert_eq!(AuthResult::from(SpfResult::None), AuthResult::None);
        assert_eq!(AuthResult::from(SpfResult::TempError), AuthResult::TempError);
        assert_eq!(AuthResult::from(SpfResult::PermError), AuthResult::PermError);
    }

    #[test]
    fn dkim_result_maps_every_variant() {
        let err = || mail_auth::Error::Io("x".to_string());
        assert_eq!(AuthResult::from(&DkimResult::Pass), AuthResult::Pass);
        assert_eq!(AuthResult::from(&DkimResult::Neutral(err())), AuthResult::Neutral);
        assert_eq!(AuthResult::from(&DkimResult::Fail(err())), AuthResult::Fail);
        assert_eq!(AuthResult::from(&DkimResult::PermError(err())), AuthResult::PermError);
        assert_eq!(AuthResult::from(&DkimResult::TempError(err())), AuthResult::TempError);
        assert_eq!(AuthResult::from(&DkimResult::None), AuthResult::None);
    }

    #[test]
    fn should_reject_only_when_dmarc_failed_and_policy_is_reject() {
        let base = VerificationOutcome {
            spf: AuthResult::Fail,
            dkim: AuthResult::Fail,
            dmarc: AuthResult::Fail,
            dmarc_policy: Some(DmarcPolicy::Reject),
        };
        assert!(base.should_reject());

        // Failed DMARC, but the domain only asked for quarantine/no action.
        let quarantine = VerificationOutcome { dmarc_policy: Some(DmarcPolicy::Quarantine), ..pass_like(&base) };
        assert!(!quarantine.should_reject());
        let none_policy = VerificationOutcome { dmarc_policy: Some(DmarcPolicy::None), ..pass_like(&base) };
        assert!(!none_policy.should_reject());

        // p=reject, but DMARC actually passed.
        let passed = VerificationOutcome { dmarc: AuthResult::Pass, ..pass_like(&base) };
        assert!(!passed.should_reject());

        // No DMARC record at all (never evaluated).
        let no_record = VerificationOutcome { dmarc_policy: None, ..pass_like(&base) };
        assert!(!no_record.should_reject());
    }

    /// Clones the fields `should_reject`'s test cases don't vary, without
    /// requiring `VerificationOutcome: Clone`.
    fn pass_like(base: &VerificationOutcome) -> VerificationOutcome {
        VerificationOutcome { spf: base.spf, dkim: base.dkim, dmarc: base.dmarc, dmarc_policy: base.dmarc_policy }
    }
}
