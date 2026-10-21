use crate::mail::message::IncomingMail;
use candid::{Decode, Encode, Principal};
use ic_agent::Agent;

/// Forwards one parsed message to `canister_id`'s `receive_mail` method - the
/// candid interface any canister opting into this bridge implements. See
/// README.md for the full shape and the authorization a `receive_mail`
/// implementation should check (this bridge's own identity, not enforced here).
pub async fn receive_mail(agent: &Agent, canister_id: Principal, mail: &IncomingMail) -> anyhow::Result<()> {
    let arg = Encode!(mail)?;
    let response = agent.update(&canister_id, "receive_mail").with_arg(arg).call_and_wait().await?;
    let result = Decode!(&response, Result<(), String>)?;
    result.map_err(|e| anyhow::anyhow!("{canister_id} rejected the message: {e}"))
}
