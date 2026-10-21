use crate::transport::{encode, CanisterClient};
use crate::{Principal, Result};
use candid::CandidType;
#[cfg(feature = "client")]
use ic_agent::Agent;
use serde::{Deserialize, Serialize};
#[cfg(feature = "client")]
use std::sync::Arc;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum Value {
    Null,
    Text(String),
    Boolean(bool),
    Bytes(#[serde(with = "serde_bytes")] Vec<u8>),
    Float(f64),
    Integer(i64),
}

#[derive(Clone)]
pub struct KvClient(CanisterClient);

impl KvClient {
    #[cfg(feature = "client")]
    pub fn new(agent: Arc<Agent>, canister_id: Principal) -> Self {
        Self(CanisterClient::new(agent, canister_id))
    }

    #[cfg(feature = "client")]
    pub fn from_text(agent: Arc<Agent>, canister_id: &str) -> Result<Self> {
        Ok(Self(CanisterClient::from_text(agent, canister_id)?))
    }

    /// Creates a client for bounded calls made from a Rust canister.
    #[cfg(feature = "ic")]
    pub fn for_canister(canister_id: Principal) -> Self {
        Self(CanisterClient::for_canister(canister_id))
    }

    pub fn canister_id(&self) -> Principal {
        self.0.canister_id()
    }

    pub async fn set(&self, key: impl Into<String>, value: Value) -> Result<Option<Value>> {
        const METHOD: &str = "set";
        self.0
            .update(METHOD, encode(METHOD, (key.into(), value))?)
            .await
    }

    pub async fn set_many(&self, entries: Vec<(String, Value)>) -> Result<u64> {
        const METHOD: &str = "set_many";
        self.0.update(METHOD, encode(METHOD, (entries,))?).await
    }

    pub async fn get(&self, key: impl Into<String>) -> Result<Option<Value>> {
        const METHOD: &str = "get";
        self.0.query(METHOD, encode(METHOD, (key.into(),))?).await
    }

    pub async fn get_many(&self, keys: Vec<String>) -> Result<Vec<Option<Value>>> {
        const METHOD: &str = "get_many";
        self.0.query(METHOD, encode(METHOD, (keys,))?).await
    }

    pub async fn delete(&self, key: impl Into<String>) -> Result<Option<Value>> {
        const METHOD: &str = "delete";
        self.0.update(METHOD, encode(METHOD, (key.into(),))?).await
    }

    pub async fn exists(&self, key: impl Into<String>) -> Result<bool> {
        const METHOD: &str = "exists";
        self.0.query(METHOD, encode(METHOD, (key.into(),))?).await
    }

    pub async fn keys(&self, prefix: Option<String>) -> Result<Vec<String>> {
        const METHOD: &str = "keys";
        self.0.query(METHOD, encode(METHOD, (prefix,))?).await
    }

    pub async fn len(&self) -> Result<u64> {
        const METHOD: &str = "len";
        self.0.query(METHOD, encode(METHOD, ())?).await
    }

    pub async fn is_empty(&self) -> Result<bool> {
        Ok(self.len().await? == 0)
    }

    pub async fn clear(&self) -> Result<u64> {
        const METHOD: &str = "clear";
        self.0.update(METHOD, encode(METHOD, ())?).await
    }

    pub async fn llm_context(&self) -> Result<String> {
        const METHOD: &str = "llm_context";
        self.0.query(METHOD, encode(METHOD, ())?).await
    }
}
