use crate::{Error, Result};
use candid::{CandidType, Principal};
#[cfg(feature = "client")]
use ic_agent::Agent;
use serde::de::DeserializeOwned;
#[cfg(feature = "client")]
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct CanisterClient {
    backend: Backend,
    canister_id: Principal,
}

#[derive(Clone)]
enum Backend {
    #[cfg(feature = "client")]
    Agent(Arc<Agent>),
    #[cfg(feature = "ic")]
    Canister,
}

impl CanisterClient {
    #[cfg(feature = "client")]
    pub(crate) fn new(agent: Arc<Agent>, canister_id: Principal) -> Self {
        Self {
            backend: Backend::Agent(agent),
            canister_id,
        }
    }

    #[cfg(feature = "client")]
    pub(crate) fn from_text(agent: Arc<Agent>, canister_id: &str) -> Result<Self> {
        Ok(Self::new(agent, Principal::from_text(canister_id)?))
    }

    #[cfg(feature = "ic")]
    pub(crate) fn for_canister(canister_id: Principal) -> Self {
        Self {
            backend: Backend::Canister,
            canister_id,
        }
    }

    pub(crate) fn canister_id(&self) -> Principal {
        self.canister_id
    }

    pub(crate) async fn query<T>(&self, method: &'static str, arg: Vec<u8>) -> Result<T>
    where
        T: CandidType + DeserializeOwned,
    {
        let bytes = self.call(CallKind::Query, method, arg).await?;
        candid::decode_one(&bytes).map_err(|source| Error::Decode { method, source })
    }

    pub(crate) async fn update<T>(&self, method: &'static str, arg: Vec<u8>) -> Result<T>
    where
        T: CandidType + DeserializeOwned,
    {
        let bytes = self.call(CallKind::Update, method, arg).await?;
        candid::decode_one(&bytes).map_err(|source| Error::Decode { method, source })
    }

    async fn call(&self, kind: CallKind, method: &'static str, arg: Vec<u8>) -> Result<Vec<u8>> {
        #[cfg(not(feature = "client"))]
        let _ = kind;

        match &self.backend {
            #[cfg(feature = "client")]
            Backend::Agent(agent) => {
                let result = match kind {
                    CallKind::Query => {
                        agent
                            .query(&self.canister_id, method)
                            .with_arg(arg)
                            .call()
                            .await
                    }
                    CallKind::Update => {
                        agent
                            .update(&self.canister_id, method)
                            .with_arg(arg)
                            .call_and_wait()
                            .await
                    }
                };
                result.map_err(|source| Error::Agent {
                    canister: self.canister_id,
                    method,
                    source: Box::new(source),
                })
            }
            #[cfg(feature = "ic")]
            Backend::Canister => {
                // Query-declared methods are still inter-canister messages here.
                // Bounded waiting prevents an unavailable callee from blocking
                // this canister's upgrades indefinitely.
                ic_cdk::call::Call::bounded_wait(self.canister_id, method)
                    .take_raw_args(arg)
                    .await
                    .map(ic_cdk::call::Response::into_bytes)
                    .map_err(|source| Error::CanisterCall {
                        canister: self.canister_id,
                        method,
                        source,
                    })
            }
        }
    }
}

#[derive(Clone, Copy)]
enum CallKind {
    Query,
    Update,
}

pub(crate) fn encode<T: candid::utils::ArgumentEncoder>(
    method: &'static str,
    args: T,
) -> Result<Vec<u8>> {
    candid::encode_args(args).map_err(|source| Error::Encode { method, source })
}

pub(crate) fn flatten<T>(method: &'static str, value: std::result::Result<T, String>) -> Result<T> {
    value.map_err(|message| Error::Canister { method, message })
}
