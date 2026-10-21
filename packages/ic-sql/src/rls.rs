//! Row-level security metadata and the normalized database identity used by
//! every authenticated transport.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// An identity proven by the configured auth canister. `profile_id` is the
/// canonical ownership key; `principal` is optional audit/link information.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthContext {
    pub profile_id: u64,
    pub principal: Option<Principal>,
}

impl AuthContext {
    pub fn subject_key(&self) -> String {
        format!("profile:{}", self.profile_id)
    }
}

/// Opt-in owner-column policy for one table. Absence from the policy map means
/// RLS is disabled for that table.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RlsPolicy {
    pub table_name: String,
    pub owner_column: String,
}
