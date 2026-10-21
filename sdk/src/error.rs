use candid::types::principal::PrincipalError;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid canister principal: {0}")]
    InvalidPrincipal(#[from] PrincipalError),

    #[error("failed to encode Candid arguments for {method}: {source}")]
    Encode {
        method: &'static str,
        #[source]
        source: candid::Error,
    },

    #[error("failed to decode Candid response from {method}: {source}")]
    Decode {
        method: &'static str,
        #[source]
        source: candid::Error,
    },

    #[cfg(feature = "client")]
    #[error("call to {canister}.{method} failed: {source}")]
    Agent {
        canister: candid::Principal,
        method: &'static str,
        #[source]
        source: Box<ic_agent::AgentError>,
    },

    #[cfg(feature = "ic")]
    #[error("bounded inter-canister call to {canister}.{method} failed: {source}")]
    CanisterCall {
        canister: candid::Principal,
        method: &'static str,
        #[source]
        source: ic_cdk::call::CallFailed,
    },

    #[error("{method} was rejected by the canister: {message}")]
    Canister {
        method: &'static str,
        message: String,
    },
}
