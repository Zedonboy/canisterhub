//! The candid-facing shape of one conversation turn for `chat` (see
//! `lib.rs`) - `ic_rig::Message` isn't a candid type (it derives `serde`,
//! not `candid::CandidType`), so this crate's own candid interface uses
//! this instead, converting to/from `ic_rig::Message` at the boundary
//! (`llm.rs`).

use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ChatTurn {
    pub role: Role,
    pub content: String,
}

impl From<&ChatTurn> for ic_rig::Message {
    fn from(turn: &ChatTurn) -> Self {
        match turn.role {
            Role::User => ic_rig::Message::user(turn.content.clone()),
            Role::Assistant => ic_rig::Message::assistant(turn.content.clone()),
        }
    }
}
