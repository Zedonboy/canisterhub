//! Client for the `hnsw_index` canister (see `hnsw_index/README.md`) - the
//! Marketplace's semantic-search index. Mirrors `candid/hnsw_index.did`'s
//! shapes; kept as a hand-written mirror like `ic::types::MarketplaceItem`,
//! not codegen. `hnsw_index` is deployed as-is from the upstream `ic_hnsw`
//! project's own prebuilt release - see that canister's README for why - so
//! everything here talks to its stock, unmodified interface; there's no
//! canister-side code of ours to keep in sync.

use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_agent::Agent;

pub type CollectionId = u32;
pub type NodeId = u64;

/// `hnsw_index` has no "get collection by name" lookup, only `collection_info`
/// by id - so a fixed, well-known id is the only way to address the one
/// collection this project uses without an out-of-band registry. This holds
/// *only* because `ensure_marketplace_items_collection` below is the sole
/// caller of `create_collection` against this canister: collection ids are
/// assigned from a counter starting at 0, so the first (and only) collection
/// ever created is always id 0. If this canister ever ends up hosting more
/// than one collection, this needs revisiting.
pub const MARKETPLACE_ITEMS_COLLECTION_ID: CollectionId = 0;

const MARKETPLACE_ITEMS_COLLECTION_NAME: &str = "marketplace_items";

/// Dimensionality of OpenAI's `text-embedding-3-small`, which is what
/// `embeddings::embed_text` embeds with. Change this (and recreate the
/// collection, since `ic_hnsw` can't change one's dimension in place) if the
/// embedding model ever changes.
const EMBEDDING_DIM: u32 = 1536;

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum DistanceMetric {
    Cosine,
    Euclidean,
    DotProduct,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CollectionConfig {
    pub name: String,
    pub dim: u32,
    pub m: u8,
    pub ef_construction: u16,
    pub distance: DistanceMetric,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CollectionInfo {
    pub id: CollectionId,
    pub name: String,
    pub dim: u32,
    pub m: u8,
    pub ef_construction: u16,
    pub distance: DistanceMetric,
    pub node_count: u64,
    pub max_layer: u8,
    pub owner: Principal,
}

#[derive(CandidType, Deserialize)]
pub struct InsertRequest {
    pub collection_id: CollectionId,
    pub vector: Vec<f32>,
    pub metadata: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
pub struct SearchRequest {
    pub collection_id: CollectionId,
    pub vector: Vec<f32>,
    pub top_k: u32,
    pub ef_search: u32,
    pub distance: Option<DistanceMetric>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct SearchResult {
    pub id: NodeId,
    pub distance: f32,
    pub metadata: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum HnswError {
    Unauthorized,
    CollectionNotFound(u32),
    CollectionAlreadyExists,
    DimensionMismatch { expected: u32, got: u32 },
    NodeNotFound(u64),
    InvalidSearchParams,
    InvalidConfig(String),
    Internal(String),
}

impl std::fmt::Display for HnswError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Packs a marketplace item id the way `insert` stores it and `search`
/// results decode it: big-endian `u64` bytes as the node's opaque metadata.
pub fn item_id_to_metadata(item_id: u64) -> Vec<u8> {
    item_id.to_be_bytes().to_vec()
}

/// The inverse of `item_id_to_metadata` - `None` for a `SearchResult` whose
/// metadata isn't exactly 8 bytes (shouldn't happen for anything this
/// canister itself inserted, but a defensive decode beats a panic).
pub fn metadata_to_item_id(metadata: &[u8]) -> Option<u64> {
    let bytes: [u8; 8] = metadata.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
}

pub async fn collection_info(
    agent: &Agent,
    canister_id: Principal,
    id: CollectionId,
) -> Result<CollectionInfo, HnswError> {
    let arg = Encode!(&id).map_err(|e| HnswError::Internal(e.to_string()))?;
    let response = agent
        .query(&canister_id, "collection_info")
        .with_arg(arg)
        .call()
        .await
        .map_err(|e| HnswError::Internal(e.to_string()))?;
    Decode!(&response, Result<CollectionInfo, HnswError>)
        .map_err(|e| HnswError::Internal(e.to_string()))?
}

async fn create_collection(
    agent: &Agent,
    canister_id: Principal,
    config: CollectionConfig,
) -> anyhow::Result<CollectionId> {
    let arg = Encode!(&config)?;
    let response = agent
        .update(&canister_id, "create_collection")
        .with_arg(arg)
        .call_and_wait()
        .await?;
    let result = Decode!(&response, Result<CollectionId, HnswError>)?;
    result.map_err(|e| anyhow::anyhow!("create_collection failed: {e}"))
}

/// One-time setup, run at orchestrator startup: creates the `marketplace_items`
/// collection if it doesn't exist yet. The caller (`config.deploy_identity_pem`'s
/// identity) becomes its owner, which is what then lets that same identity
/// insert/search against it later with no separate `grant_access` step -
/// see `hnsw_index/README.md`'s "Access control" section.
pub async fn ensure_marketplace_items_collection(
    agent: &Agent,
    canister_id: Principal,
) -> anyhow::Result<()> {
    match collection_info(agent, canister_id, MARKETPLACE_ITEMS_COLLECTION_ID).await {
        Ok(_) => return Ok(()),
        Err(HnswError::CollectionNotFound(_)) => {}
        Err(e) => anyhow::bail!("failed to check hnsw_index's marketplace_items collection: {e}"),
    }

    let config = CollectionConfig {
        name: MARKETPLACE_ITEMS_COLLECTION_NAME.to_string(),
        dim: EMBEDDING_DIM,
        // Small collection (expected to be low thousands of marketplace
        // items, not millions), so bias towards recall over insert speed -
        // see ic_hnsw's own tuning guide.
        m: 16,
        ef_construction: 200,
        distance: DistanceMetric::Cosine,
    };
    let id = create_collection(agent, canister_id, config).await?;
    if id != MARKETPLACE_ITEMS_COLLECTION_ID {
        anyhow::bail!(
            "marketplace_items collection got id {id}, expected {MARKETPLACE_ITEMS_COLLECTION_ID} - \
             MARKETPLACE_ITEMS_COLLECTION_ID in src/ic/hnsw.rs needs updating"
        );
    }
    Ok(())
}

pub async fn insert(
    agent: &Agent,
    canister_id: Principal,
    req: InsertRequest,
) -> anyhow::Result<NodeId> {
    let arg = Encode!(&req)?;
    let response = agent
        .update(&canister_id, "insert")
        .with_arg(arg)
        .call_and_wait()
        .await?;
    let result = Decode!(&response, Result<NodeId, HnswError>)?;
    result.map_err(|e| anyhow::anyhow!("hnsw_index insert failed: {e}"))
}

pub async fn search(
    agent: &Agent,
    canister_id: Principal,
    req: SearchRequest,
) -> anyhow::Result<Vec<SearchResult>> {
    let arg = Encode!(&req)?;
    let response = agent
        .query(&canister_id, "search")
        .with_arg(arg)
        .call()
        .await?;
    let result = Decode!(&response, Result<Vec<SearchResult>, HnswError>)?;
    result.map_err(|e| anyhow::anyhow!("hnsw_index search failed: {e}"))
}
