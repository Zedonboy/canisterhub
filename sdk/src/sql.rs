use crate::permissions::{Access, PermissionEntry};
use crate::transport::{encode, flatten, CanisterClient};
use crate::{Principal, Result};
use candid::CandidType;
#[cfg(feature = "client")]
use ic_agent::Agent;
use serde::{Deserialize, Serialize};
#[cfg(feature = "client")]
use std::sync::Arc;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum SqlValue {
    Null,
    Text(String),
    Boolean(bool),
    Float(f64),
    Integer(i64),
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct QueryResult {
    pub rows: Vec<Vec<SqlValue>>,
    pub rows_affected: u64,
    pub message: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableDescription {
    pub name: String,
    pub row_count: u64,
    pub columns: Vec<ColumnDef>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct UniqueConstraint {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub primary_key: bool,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForeignKeyConstraint {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub foreign_table: String,
    pub referred_columns: Vec<String>,
    pub on_delete: ForeignKeyAction,
    pub on_update: ForeignKeyAction,
}

#[derive(Clone, Copy, Debug, Default, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum ForeignKeyAction {
    #[default]
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckConstraint {
    pub name: Option<String>,
    pub expression: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ColumnDefault {
    pub column: String,
    pub value: SqlValue,
}

#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq)]
pub struct RelationalConstraints {
    pub not_null: Vec<String>,
    pub unique: Vec<UniqueConstraint>,
    pub foreign_keys: Vec<ForeignKeyConstraint>,
    pub defaults: Vec<ColumnDefault>,
    pub checks: Vec<CheckConstraint>,
    pub indexes: Vec<IndexDefinition>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ConstraintDescription {
    pub table_name: String,
    pub constraints: RelationalConstraints,
}

/// `ic-sql`'s one runtime setting - see that crate's `src/config.rs`.
#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub auth_canister: Option<Principal>,
}

/// `update_config`'s argument - three states per field, same convention as
/// every other building block's own `ConfigUpdate`: outer `None` leaves
/// `auth_canister` untouched, `Some(None)` clears it, `Some(Some(id))` sets
/// it.
#[derive(Clone, Debug, Default, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ConfigUpdate {
    pub auth_canister: Option<Option<Principal>>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct RlsPolicy {
    pub table_name: String,
    pub owner_column: String,
}

#[derive(Clone)]
pub struct SqlClient(CanisterClient);

impl SqlClient {
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

    pub async fn query(&self, sql: impl Into<String>) -> Result<QueryResult> {
        const METHOD: &str = "query";
        let result = self.0.query(METHOD, encode(METHOD, (sql.into(),))?).await?;
        flatten(METHOD, result)
    }

    pub async fn execute(&self, sql: impl Into<String>) -> Result<QueryResult> {
        const METHOD: &str = "execute";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (sql.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn query_authenticated(&self, sql: impl Into<String>) -> Result<QueryResult> {
        const METHOD: &str = "query_authenticated";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (sql.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn query_with_session(
        &self,
        session_token: impl Into<String>,
        sql: impl Into<String>,
    ) -> Result<QueryResult> {
        const METHOD: &str = "query_with_session";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (session_token.into(), sql.into()))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn execute_with_session(
        &self,
        session_token: impl Into<String>,
        sql: impl Into<String>,
    ) -> Result<QueryResult> {
        const METHOD: &str = "execute_with_session";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (session_token.into(), sql.into()))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn execute_batch(&self, statements: Vec<String>) -> Result<Vec<QueryResult>> {
        const METHOD: &str = "execute_batch";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (statements,))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn execute_batch_with_session(
        &self,
        session_token: impl Into<String>,
        statements: Vec<String>,
    ) -> Result<Vec<QueryResult>> {
        const METHOD: &str = "execute_batch_with_session";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (session_token.into(), statements))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn list_tables(&self) -> Result<Vec<String>> {
        const METHOD: &str = "list_tables";
        self.0.query(METHOD, encode(METHOD, ())?).await
    }

    pub async fn describe_table(&self, table_name: impl Into<String>) -> Result<TableDescription> {
        const METHOD: &str = "describe_table";
        let result = self
            .0
            .query(METHOD, encode(METHOD, (table_name.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn describe_constraints(
        &self,
        table_name: impl Into<String>,
    ) -> Result<ConstraintDescription> {
        const METHOD: &str = "describe_constraints";
        let result = self
            .0
            .query(METHOD, encode(METHOD, (table_name.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn llm_context(&self) -> Result<String> {
        const METHOD: &str = "llm_context";
        self.0.query(METHOD, encode(METHOD, ())?).await
    }

    // -----------------------------------------------------------------
    // Authorization config and permission data. Permission reads are public;
    // ACL mutations and typed config management are controller-only.
    // -----------------------------------------------------------------

    pub async fn set_permission(&self, principal: Principal, access: Access) -> Result<()> {
        const METHOD: &str = "set_permission";
        let result = self
            .0
            .update(
                METHOD,
                encode(
                    METHOD,
                    (PermissionEntry {
                        module: "database".to_string(),
                        principal,
                        access,
                    },),
                )?,
            )
            .await?;
        flatten(METHOD, result)
    }

    pub async fn remove_permission(&self, principal: Principal) -> Result<()> {
        const METHOD: &str = "remove_permission";
        let result = self
            .0
            .update(METHOD, encode(METHOD, ("database", principal))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn get_permission(&self, principal: Principal) -> Result<Option<Access>> {
        const METHOD: &str = "get_permission";
        self.0
            .query(METHOD, encode(METHOD, ("database", principal))?)
            .await
    }

    pub async fn list_permissions(&self) -> Result<Vec<PermissionEntry>> {
        const METHOD: &str = "list_permissions";
        self.0
            .query(METHOD, encode(METHOD, (Some("database"),))?)
            .await
    }

    pub async fn update_config(&self, update: ConfigUpdate) -> Result<()> {
        const METHOD: &str = "update_config";
        let result = self.0.update(METHOD, encode(METHOD, (update,))?).await?;
        flatten(METHOD, result)
    }

    pub async fn get_config(&self) -> Result<Config> {
        const METHOD: &str = "get_database_config";
        let result = self.0.query(METHOD, encode(METHOD, ())?).await?;
        flatten(METHOD, result)
    }

    pub async fn enable_rls(
        &self,
        table_name: impl Into<String>,
        owner_column: impl Into<String>,
    ) -> Result<()> {
        const METHOD: &str = "enable_rls";
        let result = self
            .0
            .update(
                METHOD,
                encode(METHOD, (table_name.into(), owner_column.into()))?,
            )
            .await?;
        flatten(METHOD, result)
    }

    pub async fn disable_rls(&self, table_name: impl Into<String>) -> Result<()> {
        const METHOD: &str = "disable_rls";
        let result = self
            .0
            .update(METHOD, encode(METHOD, (table_name.into(),))?)
            .await?;
        flatten(METHOD, result)
    }

    pub async fn list_rls_policies(&self) -> Result<Vec<RlsPolicy>> {
        const METHOD: &str = "list_rls_policies";
        let result = self.0.query(METHOD, encode(METHOD, ())?).await?;
        flatten(METHOD, result)
    }
}
