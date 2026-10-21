use candid::Principal;

/// One recipient this session has accepted via `RCPT TO`, already resolved to
/// the canister it routes to.
pub struct AcceptedRecipient {
    pub address: String,
    pub canister_id: Principal,
}

/// Per-connection SMTP state. RFC 5321's command sequencing (`HELO` before
/// `MAIL FROM` before `RCPT TO` before `DATA`) is enforced by checking these
/// fields in `server.rs`, not encoded as a type-state machine - simpler for
/// the small number of commands this bridge actually implements.
#[derive(Default)]
pub struct Session {
    pub helo: Option<String>,
    pub mail_from: Option<String>,
    pub rcpt_to: Vec<AcceptedRecipient>,
}

impl Session {
    /// `RSET`, and implicitly the start of a new message after one `DATA`
    /// transaction completes - `HELO` itself is session-scoped, not reset.
    pub fn reset_transaction(&mut self) {
        self.mail_from = None;
        self.rcpt_to.clear();
    }
}
