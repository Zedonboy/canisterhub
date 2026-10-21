//! Mirrors the subset of `backend/backend.did` the orchestrator needs. Kept as a
//! plain hand-written mirror (rather than a codegen step) since it's a handful of
//! read-only fields; if `backend.did` changes shape, update this to match.

use candid::{CandidType, Deserialize, Principal};
use serde::Serialize;

#[derive(CandidType, Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
pub enum MarketplaceItemType {
    Package,
    Template,
}

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
pub struct MarketplaceItem {
    pub id: u64,
    pub package_slug: String,
    pub item_type: MarketplaceItemType,
    /// `Some` iff `price` is `Some` - see `backend/backend.did`'s doc comment on
    /// this field. An item carrying this can't be installed by this off-chain
    /// agent: only a vetKD-authorized buyer can decrypt the release artifact.
    pub encrypted_key: Option<Vec<u8>>,
    pub title: String,
    pub publisher: Principal,
    pub description: String,
    pub web_url: Option<String>,
    pub created_at: u64,
    pub download_url: String,
    /// SHA-256 of the exact bytes an installer fetches from the manifest's
    /// `wasm_url` - must be checked against the actually-downloaded bytes
    /// before install (see `llm::tools::download_wasm`'s caller); the
    /// manifest and release asset are both off-chain and otherwise
    /// swappable after publishing.
    pub wasm_hash: Vec<u8>,
    pub git_repo_url: String,
    /// Exact ICP price in e8s.
    pub price: Option<u64>,
    /// Popularity signal used to break ties between semantically-similar
    /// search results - see `embeddings::rank_search_results`.
    pub downloads: u64,
}

impl MarketplaceItem {
    pub fn is_gated(&self) -> bool {
        self.encrypted_key.is_some()
    }
}
