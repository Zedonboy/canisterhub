// ic-vetkeys transitively depends on `rand`/`getrandom` for client-side vetKey
// and IBE helpers this canister never calls (all real cryptographic
// randomness in the vetKD flow we use — key derivation itself — happens off
// this canister, in the subnet's threshold protocol and in the caller's own
// browser/CI decryption code). getrandom has no entropy source on
// wasm32-unknown-unknown and won't compile without a registered custom
// backend, so this traps loudly rather than silently supplying weak
// randomness, on the assumption this path is genuinely unreachable from the
// KeyManager methods this canister actually calls.
getrandom::register_custom_getrandom!(unreachable_getrandom);
fn unreachable_getrandom(_buf: &mut [u8]) -> Result<(), getrandom::Error> {
    ic_cdk::trap(
        "unexpected: an on-canister code path requested local randomness via `getrandom`; \
         this canister's use of ic-vetkeys was assumed not to need it",
    )
}

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use candid::{CandidType, Nat, Principal};
use hmac::{Hmac, Mac};
use ic_asset_certification::{Asset, AssetConfig, AssetFallbackConfig, AssetRouter};
use ic_cdk::call::Call;
use ic_cdk::management_canister::{raw_rand, VetKDCurve, VetKDKeyId};
use ic_cdk::{init, post_upgrade, query, update};
use ic_http_certification::{HttpRequest, HttpResponse, StatusCode};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};
use ic_vetkeys::key_manager::KeyManager;
use ic_vetkeys::types::{AccessRights, ByteBuf, KeyName};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::Memo;
use icrc_ledger_types::icrc2::transfer_from::{TransferFromArgs, TransferFromError};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

mod managed_ai;
mod package_registry;
mod project_notifications;
mod web_push;
pub use managed_ai::{
    ManagedAiChoice, ManagedAiCompletionRequest, ManagedAiCompletionResponse,
    ManagedAiConfigUpdate, ManagedAiMessage, ManagedAiRequest, ManagedAiResponse, ManagedAiRole,
    ManagedAiService, ManagedAiStatus, ManagedAiUsage, TokenCreditBalance, TokenUsage,
};
pub use package_registry::{InstalledPackage, PackageInfo, PackageInfoInput};

type Memory = VirtualMemory<DefaultMemoryImpl>;

const ITEMS_MEM_ID: MemoryId = MemoryId::new(0);
const ITEM_ID_COUNTER_MEM_ID: MemoryId = MemoryId::new(1);
const KEY_MANAGER_CONFIG_MEM_ID: MemoryId = MemoryId::new(2);
const KEY_MANAGER_ACCESS_CONTROL_MEM_ID: MemoryId = MemoryId::new(3);
const KEY_MANAGER_SHARED_KEYS_MEM_ID: MemoryId = MemoryId::new(4);
const REPO_OWNERS_MEM_ID: MemoryId = MemoryId::new(5);
const KEY_NAME_OWNERS_MEM_ID: MemoryId = MemoryId::new(6);
const JWT_SIGNING_KEY_MEM_ID: MemoryId = MemoryId::new(7);
const PROJECTS_MEM_ID: MemoryId = MemoryId::new(8);
const PACKAGE_INFOS_MEM_ID: MemoryId = MemoryId::new(16);
const PROJECT_PACKAGE_INSTALLS_MEM_ID: MemoryId = MemoryId::new(17);
const PROJECT_NOTIFICATION_PREFERENCES_MEM_ID: MemoryId = MemoryId::new(18);
// This file's MemoryId numbering has an open, unresolved question about
// whether it still matches what's actually encoded in any already-deployed
// canister's stable memory (see the `list_my_projects`/`Project` decode
// failures this surfaced - project notes). Do not renumber, reorder, or
// reuse any id above without resolving that first; a new stable structure
// should start well past every id this file has ever used (15), not at 9.

/// The canonical ICP ledger id is the same on mainnet and on the managed
/// local network when `nns: true` is enabled in `icp.yaml`.
const ICP_LEDGER_CANISTER_ID: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";

// Public updates write directly to stable memory, so every caller-controlled
// value needs an explicit bound. These are byte limits (not Unicode scalar
// counts), matching the actual storage and ingress cost.
const MAX_URL_BYTES: usize = 2_048;
const MAX_MARKETPLACE_TITLE_BYTES: usize = 200;
const MAX_MARKETPLACE_DESCRIPTION_BYTES: usize = 16 * 1_024;
const MAX_RELEASE_TAG_BYTES: usize = 255;
const MAX_PACKAGE_SLUG_BYTES: usize = 100;
const MAX_ENCRYPTED_KEY_BYTES: usize = 16 * 1_024;
/// SHA-256 digest length, enforced exactly on `publish_marketplace_item`'s
/// `wasm_hash` argument.
const WASM_HASH_BYTES: usize = 32;
const VETKD_TRANSPORT_PUBLIC_KEY_BYTES: usize = 48;
const MAX_PROJECT_ID_BYTES: usize = 128;
const MAX_PROJECT_REQUEST_BYTES: usize = 32 * 1_024;
const MAX_PROJECT_NETWORK_BYTES: usize = 64;
const MAX_PROJECT_NAME_BYTES: usize = 256;
const MAX_PENDING_QUESTION_BYTES: usize = 8 * 1_024;
const MAX_LLM_CONTEXT_BYTES: usize = 256 * 1_024;
const MAX_PROJECT_RESULT_BYTES: usize = 32 * 1_024;
const MAX_CANISTER_NAME_BYTES: usize = 128;
const MAX_PROJECT_CANISTERS: usize = 256;
/// How long an `issue_jwt` access token remains valid. Callers (e.g. the
/// orchestrator's frontend) are expected to call `issue_jwt` again once theirs
/// expires rather than this being long-lived.
const JWT_TTL_SECS: u64 = 60 * 60;

/// `build.rs` maps `IC_ENV=ic` to this compile-time cfg. KeyManager persists
/// the resulting configuration in stable memory, so changing IC_ENV on an
/// upgrade does not rotate keys already used by an installed canister.
#[cfg(vetkd_mainnet)]
const VETKD_KEY_NAME: &str = "key_1";
#[cfg(not(vetkd_mainnet))]
const VETKD_KEY_NAME: &str = "test_key_1";

/// Domain separator fed into every vetKD derivation this canister performs.
/// Must stay in sync with whatever frontend/CI code independently constructs
/// or verifies vetKD contexts — a mismatch derives a *different* key with no
/// error, which is one of the vetkd skill's explicitly called-out pitfalls.
// This legacy value is part of every already-published paid item's key
// derivation and must not change. It no longer denotes a separate app-Wasm
// key; all keys admitted below are registered marketplace repository keys.
const KEY_MANAGER_DOMAIN_SEPARATOR: &str = "canister_hub_app_wasm_v1";

fn require_authenticated_caller(action: &str) -> Result<Principal, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err(format!(
            "anonymous callers may not {action} — authenticate with Internet Identity first"
        ));
    }
    Ok(caller)
}

fn ensure_text_size(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!(
            "{label} is too large ({} bytes; maximum {max_bytes})",
            value.len()
        ));
    }
    Ok(())
}

fn ensure_optional_text_size(
    label: &str,
    value: Option<&String>,
    max_bytes: usize,
) -> Result<(), String> {
    if let Some(value) = value {
        ensure_text_size(label, value, max_bytes)?;
    }
    Ok(())
}

fn ensure_optional_https_url(label: &str, value: Option<&String>) -> Result<(), String> {
    ensure_optional_text_size(label, value, MAX_URL_BYTES)?;
    if value.is_some_and(|url| !url.starts_with("https://")) {
        return Err(format!("{label} must use HTTPS"));
    }
    Ok(())
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub enum MarketplaceItemType {
    #[default]
    Package,
    Template,
}

/// Controller-supplied metadata for an official marketplace template.
///
/// Templates are always public and free. Their `download_url` points to the
/// template's `canister_hub.toml` GitHub Release asset. `manifest_hash` is the
/// SHA-256 of that manifest's exact bytes; internally it occupies the existing
/// marketplace integrity field so no stable-storage migration is required.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct MarketplaceTemplateInput {
    pub title: String,
    pub description: String,
    pub web_url: Option<String>,
    pub git_repo_url: String,
    pub download_url: String,
    pub release_tag: String,
    pub package_slug: String,
    pub manifest_hash: Vec<u8>,
}

/// A package or project template published to the marketplace.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MarketplaceItem {
    pub id: u64,
    /// Stable identity within `git_repo_url`. Releases with the same slug
    /// update this item; different slugs create independent listings.
    pub package_slug: String,
    /// Older stored rows predate this field and are package releases.
    #[serde(default)]
    pub item_type: MarketplaceItemType,
    pub title: String,
    pub description: String,
    pub web_url: Option<String>,
    pub git_repo_url: String,
    /// Absolute URL of the listing's public `canister_hub.toml` manifest.
    /// The manifest, rather than this row, describes the actual Wasm package
    /// or the packages/configuration that make up a template.
    #[serde(alias = "release_download_url")]
    pub download_url: String,
    /// SHA-256 of the exact bytes an installer fetches from the manifest's
    /// `wasm_url` — the AES-GCM-encrypted artifact for a paid item, the raw
    /// Wasm itself for a free one. Supplied by the verified publisher at
    /// publish time; this canister never downloads or recomputes it. This is
    /// what anchors install-time integrity to something immutable once
    /// published, since `download_url`'s manifest and the GitHub Release
    /// asset at `wasm_url` both live off-chain and could otherwise be
    /// swapped after the fact with no on-chain trace. `#[serde(default)]` so
    /// rows published before this field existed still decode — they come
    /// back with an empty hash, which `is_current_marketplace_item` then
    /// excludes from every read/install/payment path until republished.
    #[serde(default)]
    pub wasm_hash: Vec<u8>,
    /// Exact ICP price in e8s. `None` means free.
    pub price: Option<u64>,
    /// Present if and only if `price` is: an Identity-Based-Encryption
    /// ciphertext (`@dfinity/vetkeys`' `IbeCiphertext`) of the random
    /// AES-256 key the publisher's CI encrypted the package manifest's Wasm
    /// artifact with. Encrypted to this item's own vetkey identity (see
    /// `item_key_id`) — this canister stores it opaquely and can never
    /// decrypt it itself; only a buyer granted read access via
    /// `set_user_rights` can derive the matching vetkey (through
    /// `get_encrypted_vetkey`) and decrypt it client-side. Free items have
    /// nothing worth gating, so they carry no key at all.
    pub encrypted_key: Option<Vec<u8>>,
    pub publisher: Principal,
    pub created_at: u64,
    /// Popularity signal `orchestrator` uses to break ties between
    /// semantically-similar marketplace items (see `record_download` and
    /// `services/orchestrator/src/embeddings.rs`'s ranking) - not tied to any real
    /// payment/entitlement flow, just a counter anyone can bump.
    /// `#[serde(default)]` so items published (and CBOR-encoded into stable
    /// memory) before this field existed still decode: they come back as 0
    /// rather than failing to load after an upgrade.
    #[serde(default)]
    pub downloads: u64,
    /// One idempotent ICP payment journal entry per buyer. A `None` block
    /// height means the transfer outcome has not yet been confirmed; retries
    /// reuse `created_at_time`, allowing the ledger to reject a second charge
    /// as an ICRC-2 duplicate. This intentionally changes the development
    /// storage schema.
    #[serde(default)]
    pub purchases: BTreeMap<Principal, MarketplacePurchase>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MarketplacePurchase {
    pub created_at_time: u64,
    /// Immutable amount used by every retry, even if the publisher changes
    /// the current listing price while the ledger result is pending.
    pub amount_e8s: u64,
    pub block_height: Option<Nat>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MarketplacePurchaseReceipt {
    pub ledger_canister_id: Principal,
    pub amount_e8s: u64,
    pub block_index: Option<Nat>,
    pub already_owned: bool,
}

impl Storable for MarketplaceItem {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![];
        ciborium::into_writer(self, &mut buf).expect("Failed to encode MarketplaceItem");
        Cow::Owned(buf)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        ciborium::from_reader(bytes.as_ref()).expect("Failed to decode MarketplaceItem")
    }
}

// ---------------------------------------------------------------------------
// Project tracking
//
// One `Project` per app the dashboard's user is building: which project
// exists, what it's for, its owner, its current state, and - the field
// every direct-to-canister call from the dashboard depends on - every
// canister id provisioned into it so far. Every method below is owner-gated
// (`msg_caller() == project.owner`) and is called *directly by the
// frontend*, as the real signed-in user - the orchestrator has no part in
// any of this (see the `decouple-orchestrator-api` project notes): it's
// invoked only for AI-prompt-driven building, and never reads or writes a
// `Project` record here. `owner` is simply whoever calls `create_project`.
//
// Canister-owned data (stats, database contents) is deliberately *not*
// tracked here - only enough to know a canister exists and what kind it is,
// so the dashboard can go call it directly for anything else.
// ---------------------------------------------------------------------------

/// Which building block a tracked canister actually is. `Notification` is
/// retained for decoding older project records; Web Push now lives in backend.
#[derive(Clone, Copy, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum CanisterKind {
    Connector,
    Agent,
    AdminAgent,
    /// Legacy project-owned Web Push canister kind.
    Notification,
    Auth,
    Database,
    Analytics,
    Static,
    Other,
}

/// One tracked canister's identity.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanisterInfo {
    pub id: Principal,
    pub kind: CanisterKind,
    /// Stable `.wasm` artifact name. `None` covers imported,
    /// runtime-created, and legacy canisters that were not installed from the
    /// package registry. This belongs on the canonical project record so an
    /// installer can resolve package dependencies before initializing a new
    /// canister without joining against release-history records.
    pub package_name: Option<String>,
}

/// A project's own lifecycle - `AwaitingAnswer`/`Succeeded`/`Failed` only
/// mean anything once something (the frontend, driving a real Orchestrate
/// conversation) actually calls `update_project_state`/`finish_project` to
/// reflect it - `backend` itself has no opinion on what drives these
/// transitions, only that the caller is the project's own owner.
#[derive(Clone, Copy, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProjectState {
    Running,
    AwaitingAnswer,
    Succeeded,
    Failed,
}

/// A single orchestrated app - see this section's own header comment.
/// `canisters` is authoritative and additive-only (see
/// `add_project_canisters`): the dashboard's only source of truth for which
/// canister ids belong to this project.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub request: String,
    pub network: String,
    /// The real end-user principal that created this project - `get_project`/
    /// `list_my_projects` only ever return a project to its own owner. Set
    /// once, at `create_project`, to `msg_caller()` directly: the caller
    /// creates their own project as themselves, with no other party
    /// asserting it on their behalf.
    pub owner: Principal,
    pub state: ProjectState,
    pub pending_question: Option<String>,
    pub project_name: Option<String>,
    pub canisters: std::collections::BTreeMap<String, CanisterInfo>,
    pub llm_context: Option<String>,
    pub final_message: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl Storable for Project {
    const BOUND: Bound = Bound::Unbounded;

    // Deliberately candid, not ciborium (unlike `MarketplaceItem` above):
    // the same candid type defined for this canister's public interface is
    // exactly what's stored on the stable heap, with no second,
    // ciborium-shaped representation of the same data to keep in sync.
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("Failed to encode Project"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("Failed to decode Project")
    }
}

#[cfg(test)]
mod project_storage_compatibility_tests {
    use super::*;

    #[derive(CandidType, Deserialize)]
    struct LegacyCanisterInfo {
        id: Principal,
        kind: CanisterKind,
    }

    #[derive(CandidType, Deserialize)]
    struct LegacyProject {
        id: String,
        request: String,
        network: String,
        owner: Principal,
        state: ProjectState,
        pending_question: Option<String>,
        project_name: Option<String>,
        canisters: BTreeMap<String, LegacyCanisterInfo>,
        llm_context: Option<String>,
        final_message: Option<String>,
        error: Option<String>,
        created_at: u64,
        updated_at: u64,
    }

    #[test]
    fn project_decodes_canisters_written_before_package_names() {
        let canister = Principal::from_slice(&[42; 10]);
        let legacy = LegacyProject {
            id: "legacy".to_string(),
            request: "test".to_string(),
            network: "local".to_string(),
            owner: Principal::from_slice(&[1; 10]),
            state: ProjectState::Running,
            pending_question: None,
            project_name: None,
            canisters: BTreeMap::from([(
                "agent".to_string(),
                LegacyCanisterInfo {
                    id: canister,
                    kind: CanisterKind::Agent,
                },
            )]),
            llm_context: None,
            final_message: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        };

        let bytes = candid::encode_one(legacy).unwrap();
        let decoded: Project = candid::decode_one(&bytes).unwrap();
        assert_eq!(decoded.canisters["agent"].id, canister);
        assert_eq!(decoded.canisters["agent"].package_name, None);
    }
}

// Wire types used by the protocol backend's Web Push API and project gateway.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    pub url: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushDelivery {
    pub endpoint: String,
    pub status: Option<u16>,
    pub error: Option<String>,
    pub subscription_removed: bool,
}

/// Project owner's saved preferences for project Web Push delivery. Missing
/// entries retain the historical enabled behavior for existing projects.
#[derive(Clone, Copy, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectNotificationPreferences {
    pub push_enabled: bool,
}

pub(crate) fn project_push_notifications_enabled(project_id: &str) -> bool {
    PROJECT_NOTIFICATION_PREFERENCES.with(|preferences| {
        preferences.borrow().get(&project_id.to_string()).unwrap_or(true)
    })
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static ITEMS: RefCell<StableBTreeMap<u64, MarketplaceItem, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(ITEMS_MEM_ID)))
    );

    static ITEM_ID_COUNTER: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(ITEM_ID_COUNTER_MEM_ID)), 0u64)
    );

    /// vetKD-backed key distribution for paid marketplace release artifacts.
    /// Unlike a canister-held secret, this canister never sees the
    /// plaintext key material it gatekeeps — it only ever forwards an
    /// encrypted vetkey blob that the IC's threshold vetKD protocol produced,
    /// decryptable solely by the requesting caller's own transport secret
    /// key. See the `vetkd` skill for the full model:
    /// https://skills.internetcomputer.org/.well-known/skills/vetkd/SKILL.md
    static KEY_MANAGER: RefCell<KeyManager<AccessRights>> = RefCell::new(KeyManager::init(
        KEY_MANAGER_DOMAIN_SEPARATOR,
        VetKDKeyId {
            curve: VetKDCurve::Bls12_381_G2,
            name: VETKD_KEY_NAME.to_string(),
        },
        MEMORY_MANAGER.with(|m| m.borrow().get(KEY_MANAGER_CONFIG_MEM_ID)),
        MEMORY_MANAGER.with(|m| m.borrow().get(KEY_MANAGER_ACCESS_CONTROL_MEM_ID)),
        MEMORY_MANAGER.with(|m| m.borrow().get(KEY_MANAGER_SHARED_KEYS_MEM_ID)),
    ));

    /// Permanent binding of a GitHub `"owner/repo"` (lowercased) to the
    /// principal that registered it via `register_repo_publisher` - no
    /// GitHub-side proof, just whichever principal claims it first. Stable
    /// so a claim survives canister upgrades.
    static REPO_OWNERS: RefCell<StableBTreeMap<String, Principal, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(REPO_OWNERS_MEM_ID)))
    );

    /// The same binding as `REPO_OWNERS`, indexed by the derived `KeyName`
    /// (see `item_key_id`) instead of the raw repo string. Lets
    /// `set_user_rights` / `remove_user` / `get_user_rights` authorize "the
    /// publisher who owns this specific item's key" without a linear scan —
    /// populated at the same time as `REPO_OWNERS`.
    static KEY_NAME_OWNERS: RefCell<StableBTreeMap<KeyName, Principal, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(KEY_NAME_OWNERS_MEM_ID)))
    );

    /// HMAC-SHA256 key `issue_jwt` signs access tokens with. Empty until a
    /// controller calls `init_jwt_signing_key` — see that function for why
    /// this isn't just generated on first use.
    static JWT_SIGNING_KEY: RefCell<StableCell<Vec<u8>, Memory>> = RefCell::new(
        StableCell::init(MEMORY_MANAGER.with(|m| m.borrow().get(JWT_SIGNING_KEY_MEM_ID)), Vec::new())
    );

    /// Every tracked `Project`, keyed by its id - see that type's own doc
    /// comment.
    static PROJECTS: RefCell<StableBTreeMap<String, Project, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROJECTS_MEM_ID)))
    );

    /// Controller-curated installable package releases, keyed by their stable
    /// package id (for example `agent` or `order_inventory`).
    static PACKAGE_INFOS: RefCell<StableBTreeMap<String, PackageInfo, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PACKAGE_INFOS_MEM_ID)))
    );

    /// Immutable-at-install snapshots tying a project canister to the package
    /// release whose bytes were installed. A later catalog SHA therefore does
    /// not rewrite history; it becomes an update signal in the dashboard.
    static PROJECT_PACKAGE_INSTALLS: RefCell<StableBTreeMap<String, InstalledPackage, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROJECT_PACKAGE_INSTALLS_MEM_ID)))
    );

    /// Owner-controlled project Web Push preference. New projects default to
    /// enabled so adding this setting does not mute existing subscriptions.
    static PROJECT_NOTIFICATION_PREFERENCES: RefCell<StableBTreeMap<String, bool, Memory>> = RefCell::new(
        StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(PROJECT_NOTIFICATION_PREFERENCES_MEM_ID)))
    );

    /// Certified HTTP assets for the marketing landing page (see "Landing
    /// page assets" below) - deliberately *not* part of the `MemoryManager`-
    /// backed stable storage above: every byte here is already compiled
    /// into this canister's own wasm via `include_dir!`, so there is
    /// nothing to persist across an upgrade that `init_landing_assets`
    /// can't just rebuild from scratch.
    static ASSET_ROUTER: RefCell<AssetRouter<'static>> = RefCell::new(AssetRouter::default());
}

// ---------------------------------------------------------------------------
// Landing page assets
//
// `backend` doubles as the host for the CanisterHub marketing site
// (`landing/`, a separate Vite/React app - see that folder's own README):
// its static build output is embedded directly into this canister's wasm at
// compile time and served as certified HTTP assets, so visiting this
// canister's own URL shows the landing page rather than a bare candid-UI
// fallback. This has nothing to do with the `frontend` canister (the signed-
// in dashboard) - two different canisters, two different audiences, the
// same IC `http_request`/asset-certification mechanism.
//
// Requires `landing/dist` to exist *before* this crate compiles - run
// `npm install && npm run build` in `landing/` first (same precondition
// `frontend`'s own `npm run build` has on `npm run generate` - see that
// package.json). `landing/dist` is gitignored, same as `frontend/dist`;
// nothing here commits a stale build.
// ---------------------------------------------------------------------------

static LANDING_ASSETS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../landing/dist");

/// Walks `dir` recursively, turning every embedded file into an
/// `ic-asset-certification` `Asset` keyed by its path relative to
/// `landing/dist` (e.g. `assets/index-abc123.js`) - exactly the path shape
/// `AssetConfig`'s `path`/`pattern` matching below expects.
fn collect_assets(dir: &'static Dir<'static>, out: &mut Vec<Asset<'static, 'static>>) {
    for file in dir.files() {
        out.push(Asset::new(
            file.path().to_string_lossy().into_owned(),
            file.contents(),
        ));
    }
    for subdir in dir.dirs() {
        collect_assets(subdir, out);
    }
}

/// (Re)certifies every embedded landing-page asset and updates this
/// canister's certified data accordingly. Called from both `init` and
/// `post_upgrade` - `AssetRouter` holds no stable state of its own (see the
/// `ASSET_ROUTER` thread_local's own doc comment), so this must run fresh
/// on every canister start, not just the first one.
fn init_landing_assets() {
    let mut assets = Vec::new();
    collect_assets(&LANDING_ASSETS, &mut assets);

    let immutable_cache = (
        "cache-control".to_string(),
        "public, max-age=31536000, immutable".to_string(),
    );
    let asset_configs = vec![
        // Vite's own output layout: hashed, content-addressed filenames
        // under `assets/`, safe to cache forever - a new build always gets
        // new filenames. `index.html` itself must never be cached (or a
        // returning visitor could get stuck on a stale shell pointing at
        // assets from a build that no longer exists), and doubles as the
        // SPA fallback for any path that isn't a real file (e.g. a
        // deep-link into a client-side-routed section).
        AssetConfig::File {
            path: "index.html".to_string(),
            content_type: Some("text/html".to_string()),
            headers: vec![(
                "cache-control".to_string(),
                "public, no-cache, no-store".to_string(),
            )],
            fallback_for: vec![AssetFallbackConfig {
                scope: "/".to_string(),
                status_code: Some(StatusCode::OK),
            }],
            aliased_by: vec!["/".to_string()],
            encodings: vec![],
        },
        AssetConfig::Pattern {
            pattern: "assets/*.js".to_string(),
            content_type: Some("text/javascript".to_string()),
            headers: vec![immutable_cache.clone()],
            encodings: vec![],
        },
        AssetConfig::Pattern {
            pattern: "assets/*.css".to_string(),
            content_type: Some("text/css".to_string()),
            headers: vec![immutable_cache.clone()],
            encodings: vec![],
        },
        AssetConfig::Pattern {
            pattern: "*.svg".to_string(),
            content_type: Some("image/svg+xml".to_string()),
            headers: vec![immutable_cache],
            encodings: vec![],
        },
    ];

    ASSET_ROUTER.with(|router| {
        let mut router = router.borrow_mut();
        router
            .certify_assets(assets, asset_configs)
            .expect("failed to certify landing page assets");
        ic_cdk::api::certified_data_set(router.root_hash());
    });
}

#[init]
fn init() {
    init_landing_assets();
}

#[post_upgrade]
fn post_upgrade() {
    init_landing_assets();
}

/// Serves the embedded landing page - the IC http gateway's standard entry
/// point, called for any ordinary browser request to this canister's own
/// URL. Every response is certified (`AssetRouter::serve_asset` adds the
/// `IC-Certificate` header itself from this canister's `data_certificate`),
/// so it's independently verifiable and not just trusted on the replica's
/// word - the same guarantee a dedicated asset canister provides, without
/// needing a separate canister for it.
#[query]
fn http_request(req: HttpRequest) -> HttpResponse<'static> {
    let Some(certificate) = ic_cdk::api::data_certificate() else {
        return HttpResponse::builder()
            .with_status_code(StatusCode::INTERNAL_SERVER_ERROR)
            .with_body(b"certified data not available".to_vec())
            .build();
    };
    ASSET_ROUTER.with(|router| {
        router
            .borrow()
            .serve_asset(&certificate, &req)
            .unwrap_or_else(|_| {
                HttpResponse::builder()
                    .with_status_code(StatusCode::NOT_FOUND)
                    .with_body(b"404 Not Found".to_vec())
                    .build()
            })
    })
}

/// The vetkey identity for a specific marketplace item's encrypted release,
/// derived deterministically from its lowercased `"owner/repo"` and stable
/// package slug — stable across republishes/updates to the same package, unlike the item's
/// numeric id (which doesn't exist yet at the point a publisher's CI needs
/// to encrypt *to* this identity, before `publish_marketplace_item` has even been
/// called). Repo names can exceed `KeyName`'s 32-byte bound, so this hashes
/// rather than truncates: SHA-256 output is exactly 32 bytes, always fits,
/// and collisions are not a practical concern.
///
/// "Owned" by the canister itself — `KeyManager` is a general
/// (owner, name) -> access-list store meant for many independent
/// keys, and every key this canister manages uses the same owner so that
/// granting/revoking access (see `set_user_rights` / `remove_user`) never
/// requires a real end-user "owner" identity, only the right to speak for
/// that key (a controller, or — for item keys — the item's verified
/// publisher; see `KEY_NAME_OWNERS`).
fn item_key_id(repo_key: &str, package_slug: &str) -> (Principal, KeyName) {
    let mut hasher = Sha256::new();
    hasher.update(b"canister-hub-marketplace-item-v1\0");
    hasher.update(repo_key.as_bytes());
    hasher.update(b"\0");
    hasher.update(package_slug.as_bytes());
    let digest = hasher.finalize();
    let key_name = KeyName::try_from(digest.as_slice()).expect("sha256 output is exactly 32 bytes");
    (ic_cdk::api::canister_self(), key_name)
}

/// Returns the vetkey name for a marketplace item's repository/package pair
/// (see `item_key_id`) — the same values passed to `publish_marketplace_item` — so a
/// publisher's CI doesn't have to reimplement the parsing/SHA-256
/// derivation itself to know what identity to IBE-encrypt to before
/// calling `publish_marketplace_item`.
#[query]
fn item_key_name(git_repo_url: String, package_slug: String) -> Result<Vec<u8>, String> {
    let (owner, repo) = parse_github_owner_repo(&git_repo_url)?;
    validate_package_slug(&package_slug)?;
    Ok(item_key_id(&format!("{owner}/{repo}"), &package_slug)
        .1
        .as_ref()
        .to_vec())
}

/// Extracts `(owner, repo)`, lowercased, from a `github.com` URL. Accepts the
/// common `https://github.com/{owner}/{repo}[.git]` and
/// `git@github.com:{owner}/{repo}[.git]` forms.
fn parse_github_owner_repo(git_repo_url: &str) -> Result<(String, String), String> {
    ensure_text_size("git_repo_url", git_repo_url, MAX_URL_BYTES)?;
    let s = git_repo_url.trim();
    let s = s.strip_suffix(".git").unwrap_or(s);
    let path = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("git@github.com:"))
        .ok_or_else(|| "git_repo_url must be a github.com repository URL".to_string())?;
    let path = path.trim_matches('/');
    if path.contains(['?', '#']) {
        return Err("git_repo_url must not contain a query string or fragment".to_string());
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return Err("git_repo_url must look like https://github.com/{owner}/{repo}".to_string());
    }
    let (owner, repo) = (parts[0], parts[1]);
    let valid_owner = owner.len() <= 39
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !owner.starts_with('-')
        && !owner.ends_with('-');
    let valid_repo = repo.len() <= 100
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if !valid_owner || !valid_repo {
        return Err("git_repo_url contains an invalid GitHub owner or repository name".to_string());
    }
    Ok((owner.to_lowercase(), repo.to_lowercase()))
}

fn validate_release_tag(release_tag: &str) -> Result<(), String> {
    ensure_text_size("release_tag", release_tag, MAX_RELEASE_TAG_BYTES)?;
    if release_tag.is_empty()
        || !release_tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "release_tag must contain only ASCII letters, digits, '.', '-', or '_'".to_string(),
        );
    }
    Ok(())
}

fn validate_package_slug(package_slug: &str) -> Result<(), String> {
    ensure_text_size("package_slug", package_slug, MAX_PACKAGE_SLUG_BYTES)?;
    let mut bytes = package_slug.bytes();
    let first = bytes
        .next()
        .ok_or_else(|| "package_slug must not be empty".to_string())?;
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err("package_slug must start with a lowercase ASCII letter or digit".to_string());
    }
    if !bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
    }) {
        return Err(
            "package_slug may contain only lowercase ASCII letters, digits, '-', '_', or '.'"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_manifest_download_url(
    download_url: &str,
    owner: &str,
    repo: &str,
    release_tag: &str,
    package_slug: &str,
) -> Result<(), String> {
    ensure_text_size("download_url", download_url, MAX_URL_BYTES)?;
    let expected_prefix =
        format!("https://github.com/{owner}/{repo}/releases/download/{release_tag}/");
    let lower_url = download_url.to_ascii_lowercase();
    let lower_prefix = expected_prefix.to_ascii_lowercase();
    let file_name = lower_url.strip_prefix(&lower_prefix).ok_or_else(|| {
        "download_url must be an HTTPS GitHub Release asset for the verified repository and release_tag"
            .to_string()
    })?;
    if file_name.is_empty() || file_name.contains(['/', '?', '#']) {
        return Err("download_url must end with one GitHub Release asset file name".to_string());
    }
    let package_manifest = format!("{package_slug}.canister_hub.toml");
    if file_name != "canister_hub.toml" && file_name != package_manifest {
        return Err(format!(
            "download_url must point to canister_hub.toml or {package_slug}.canister_hub.toml"
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_marketplace_item(
    caller: Principal,
    item_type: MarketplaceItemType,
    web_url: Option<String>,
    git_repo_url: String,
    title: String,
    description: String,
    download_url: String,
    price: Option<u64>,
    encrypted_key: Option<Vec<u8>>,
    package_slug: String,
    wasm_hash: Vec<u8>,
) -> u64 {
    let (owner, repo) = parse_github_owner_repo(&git_repo_url)
        .expect("marketplace repo URL must be validated before storage");
    let repo_key = format!("{owner}/{repo}");

    // A normalized GitHub repository plus package slug identifies one
    // marketplace item. A new release updates the existing listing while
    // retaining its popularity and any package purchase records.
    let existing_item = ITEMS.with(|items| {
        items.borrow().iter().find_map(|entry| {
            let item = entry.value();
            let (item_owner, item_repo) = parse_github_owner_repo(&item.git_repo_url).ok()?;
            (format!("{item_owner}/{item_repo}") == repo_key && item.package_slug == package_slug)
                .then_some(item)
        })
    });
    if let Some(existing) = existing_item {
        let id = existing.id;
        let updated = MarketplaceItem {
            id,
            package_slug,
            item_type,
            title,
            description,
            web_url,
            git_repo_url,
            download_url,
            wasm_hash,
            price,
            encrypted_key,
            publisher: caller,
            created_at: existing.created_at,
            downloads: existing.downloads,
            purchases: existing.purchases,
        };
        ITEMS.with(|items| items.borrow_mut().insert(id, updated));
        return id;
    }

    let id = ITEM_ID_COUNTER.with(|counter| {
        let mut cell = counter.borrow_mut();
        let next_id = *cell.get();
        cell.set(
            next_id
                .checked_add(1)
                .expect("marketplace item id space exhausted"),
        );
        next_id
    });

    let item = MarketplaceItem {
        id,
        package_slug,
        item_type,
        title,
        description,
        web_url,
        git_repo_url,
        download_url,
        wasm_hash,
        price,
        encrypted_key,
        publisher: caller,
        created_at: ic_cdk::api::time(),
        downloads: 0,
        purchases: BTreeMap::new(),
    };

    ITEMS.with(|items| items.borrow_mut().insert(id, item));
    id
}

#[query]
fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}

/// Registers an explicit publisher principal for a GitHub repository.
///
/// Controller-only: a bare authenticated caller cannot prove they actually
/// control `git_repo_url` (this canister has no HTTPS outcall-based GitHub
/// verification), so this is never called by an end user's own dashboard
/// session directly. The orchestrator - itself a controller of this
/// canister (see `services/orchestrator/src/github.rs`) - calls this on a
/// user's behalf only after independently verifying GitHub repository
/// ownership via OAuth (the dashboard's "Connect Git" flow in
/// `PublisherSetup.tsx`). `publisher` is the separate CI identity
/// `publish_marketplace_item` must later be signed by - it need not be, and
/// usually isn't, the same principal as the GitHub-verified owner. The
/// first registration wins; repeating it with the same publisher is a
/// no-op, while replacing it with a different publisher is rejected.
#[update]
fn register_repo_publisher(git_repo_url: String, publisher: Principal) -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err(
            "only a controller (the orchestrator, after verifying GitHub repository ownership) \
             may register a repo publisher"
                .to_string(),
        );
    }
    if publisher == Principal::anonymous() {
        return Err("publisher must not be the anonymous principal".to_string());
    }
    let (owner, repo) = parse_github_owner_repo(&git_repo_url)?;
    let repo_key = format!("{owner}/{repo}");

    REPO_OWNERS.with(|m| {
        let mut owners = m.borrow_mut();
        match owners.get(&repo_key) {
            Some(existing) if existing != publisher => Err(format!(
                "{repo_key} is already registered to a different principal"
            )),
            Some(_) => Ok(()),
            None => {
                owners.insert(repo_key.clone(), publisher);
                Ok(())
            }
        }
    })?;

    Ok(())
}

fn notification_module_moved<T>() -> Result<T, String> {
    Err("use push_ensure_vapid for browser setup and send_project_notification for project delivery".to_string())
}

#[update]
fn push_init_vapid(_subject: String) -> Result<Vec<u8>, String> {
    notification_module_moved()
}

#[update]
fn push_import_vapid(_private_key: String, _subject: String) -> Result<Vec<u8>, String> {
    notification_module_moved()
}

#[query]
fn push_vapid_public_key() -> Result<Vec<u8>, String> {
    web_push::public_key()
}

#[update]
fn push_subscribe(_subscription: PushSubscription) -> Result<(), String> {
    web_push::subscribe(require_authenticated_caller("subscribe to push notifications")?, _subscription)
}

#[update]
fn push_unsubscribe(_endpoint: String) -> Result<(), String> {
    web_push::unsubscribe(require_authenticated_caller("unsubscribe from push notifications")?, &_endpoint)
}

#[query]
fn push_list_subscriptions() -> Result<Vec<PushSubscription>, String> {
    Ok(web_push::list(&require_authenticated_caller("list push subscriptions")?))
}

#[update]
async fn push_ensure_vapid() -> Result<Vec<u8>, String> {
    require_authenticated_caller("enable push notifications")?;
    web_push::ensure_vapid().await
}

#[update]
fn push_send(
    _principal: Principal,
    _notification: PushNotification,
) -> Result<Vec<PushDelivery>, String> {
    notification_module_moved()
}

/// Adds or updates an official project template in the marketplace.
///
/// This is intentionally controller-only: unlike the general publisher API,
/// it bypasses repository-publisher registration so the platform operator can
/// seed curated templates directly. A repository/package-slug pair is stable;
/// submitting it again updates the listing without resetting its id, creation
/// time, or download counter.
#[update]
fn add_marketplace_template(info: MarketplaceTemplateInput) -> Result<u64, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() || !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may add marketplace templates".to_string());
    }

    ensure_optional_https_url("web_url", info.web_url.as_ref())?;
    ensure_text_size("title", &info.title, MAX_MARKETPLACE_TITLE_BYTES)?;
    ensure_text_size(
        "description",
        &info.description,
        MAX_MARKETPLACE_DESCRIPTION_BYTES,
    )?;
    if info.title.trim().is_empty() {
        return Err("title must not be empty".to_string());
    }
    if info.download_url.trim().is_empty() {
        return Err("download_url must not be empty".to_string());
    }
    validate_release_tag(&info.release_tag)?;
    validate_package_slug(&info.package_slug)?;
    if info.manifest_hash.len() != WASM_HASH_BYTES {
        return Err(format!(
            "manifest_hash must be exactly {WASM_HASH_BYTES} bytes"
        ));
    }

    let (owner, repo) = parse_github_owner_repo(&info.git_repo_url)?;
    validate_manifest_download_url(
        &info.download_url,
        &owner,
        &repo,
        &info.release_tag,
        &info.package_slug,
    )?;

    Ok(upsert_marketplace_item(
        caller,
        MarketplaceItemType::Template,
        info.web_url,
        info.git_repo_url,
        info.title,
        info.description,
        info.download_url,
        None,
        None,
        info.package_slug,
        info.manifest_hash,
    ))
}

/// Publishes a package or template manifest to the marketplace.
///
/// The caller must have already claimed this GitHub repository via
/// `register_repo_publisher` - a different (or not-yet-registered)
/// principal calling this for the same repo is rejected outright, not
/// silently re-verified or auto-claimed.
///
/// `encrypted_key` gates whether the release is protected at all: it must
/// be `Some` exactly when `price` is `Some`, and `None` exactly when the
/// item is free — there's nothing worth encryption-gating behind a price of
/// nothing. The publisher's own CI is expected to have generated a random
/// AES key, encrypted the release artifact with it, and IBE-encrypted *that
/// key* to this item's vetkey identity (`item_key_id`, via
/// `get_vetkey_verification_key`) before calling this method — this
/// canister only ever stores the resulting ciphertext, never a usable key.
///
/// `wasm_hash` must be the SHA-256 of the exact bytes an installer will
/// fetch from the manifest's `wasm_url` (the encrypted artifact for a paid
/// item, the raw Wasm for a free one) — computed by the publisher's own CI
/// at build time, before this call. This canister never downloads the
/// artifact itself to verify it; recording the hash here is what lets an
/// installer detect the manifest or release asset being swapped after
/// publishing, since both live off-chain and are otherwise fully
/// publisher-mutable.
#[update]
// Candid methods conventionally take positional arguments rather than a
// wrapper struct (which would just relocate the same field count into a
// record type); these named, `Option`-heavy fields read more clearly as
// positional params here than it would save by bundling them.
#[allow(clippy::too_many_arguments)]
fn publish_marketplace_item(
    item_type: MarketplaceItemType,
    web_url: Option<String>,
    git_repo_url: String,
    title: String,
    description: String,
    download_url: String,
    release_tag: String,
    price: Option<u64>,
    encrypted_key: Option<Vec<u8>>,
    package_slug: String,
    wasm_hash: Vec<u8>,
) -> Result<u64, String> {
    let caller = require_authenticated_caller("publish")?;
    ensure_optional_https_url("web_url", web_url.as_ref())?;
    ensure_text_size("title", &title, MAX_MARKETPLACE_TITLE_BYTES)?;
    ensure_text_size(
        "description",
        &description,
        MAX_MARKETPLACE_DESCRIPTION_BYTES,
    )?;
    if encrypted_key
        .as_ref()
        .is_some_and(|key| key.len() > MAX_ENCRYPTED_KEY_BYTES)
    {
        return Err(format!(
            "encrypted_key is too large (maximum {MAX_ENCRYPTED_KEY_BYTES} bytes)"
        ));
    }
    if title.trim().is_empty() {
        return Err("title must not be empty".to_string());
    }
    if download_url.trim().is_empty() {
        return Err("download_url must not be empty".to_string());
    }
    validate_release_tag(&release_tag)?;
    validate_package_slug(&package_slug)?;
    if wasm_hash.len() != WASM_HASH_BYTES {
        return Err(format!(
            "wasm_hash must be exactly {WASM_HASH_BYTES} bytes — the SHA-256 of the exact bytes \
             an installer will fetch from the manifest's wasm_url (the encrypted artifact for a \
             paid item, the raw Wasm for a free one)"
        ));
    }
    if price == Some(0) {
        return Err("price must be greater than zero e8s".to_string());
    }
    match (&price, &encrypted_key) {
        (Some(_), None) => {
            return Err(
                "a priced item must include encrypted_key — encrypt the release and IBE-wrap \
                 the key to this item's vetkey identity before publishing"
                    .to_string(),
            );
        }
        (None, Some(_)) => {
            return Err(
                "encrypted_key was provided but price is unset — free items aren't \
                 encryption-gated, so there's nothing to wrap a key for"
                    .to_string(),
            );
        }
        _ => {}
    }
    if item_type == MarketplaceItemType::Template && (price.is_some() || encrypted_key.is_some()) {
        return Err("template items must be public and free".to_string());
    }

    let (owner, repo) = parse_github_owner_repo(&git_repo_url)?;
    let repo_key = format!("{owner}/{repo}");
    validate_manifest_download_url(&download_url, &owner, &repo, &release_tag, &package_slug)?;

    let registered_owner = REPO_OWNERS.with(|m| m.borrow().get(&repo_key));
    if registered_owner != Some(caller) {
        return Err(format!(
            "{repo_key} is not registered to this principal — call register_repo_publisher first"
        ));
    }

    // Repository ownership authorizes publishing, while each package gets a
    // distinct vetKey identity and access list.
    let (_, key_name) = item_key_id(&repo_key, &package_slug);
    KEY_NAME_OWNERS.with(|owners| owners.borrow_mut().insert(key_name, caller));

    Ok(upsert_marketplace_item(
        caller,
        item_type,
        web_url,
        git_repo_url,
        title,
        description,
        download_url,
        price,
        encrypted_key,
        package_slug,
        wasm_hash,
    ))
}

/// Fetches a single marketplace item by id.
#[query]
fn get_marketplace_item(id: u64) -> Option<MarketplaceItem> {
    ITEMS.with(|items| items.borrow().get(&id).filter(is_current_marketplace_item))
}

/// Lists all marketplace items.
#[query]
fn list_marketplace_items() -> Vec<MarketplaceItem> {
    ITEMS.with(|items| {
        items
            .borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(is_current_marketplace_item)
            .collect()
    })
}

/// Rows written by the pre-manifest API remain safely decodable after an
/// upgrade, but cannot satisfy the current install contract. Keep them in
/// stable memory (no destructive migration) while excluding them from every
/// read/install/payment path until their publisher republishes them.
fn is_current_marketplace_item(item: &MarketplaceItem) -> bool {
    validate_package_slug(&item.package_slug).is_ok()
        && item.wasm_hash.len() == WASM_HASH_BYTES
        && item
            .download_url
            .rsplit_once('/')
            .is_some_and(|(_, file_name)| {
                file_name.eq_ignore_ascii_case("canister_hub.toml")
                    || file_name
                        .eq_ignore_ascii_case(&format!("{}.canister_hub.toml", item.package_slug))
            })
}

/// Bumps an item's download counter by one - a bare popularity signal, not
/// tied to any real payment/entitlement check (a production deployment would
/// call this from wherever a purchase/download is actually confirmed, e.g.
/// alongside a `get_encrypted_vetkey` success). Callable by anyone; there's
/// nothing sensitive being gated here, only a number `orchestrator` reads to
/// break ties between semantically-similar search results.
#[update]
fn record_download(id: u64) -> Result<(), String> {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let mut item = items
            .get(&id)
            .ok_or_else(|| format!("no marketplace item with id {id}"))?;
        if !is_current_marketplace_item(&item) {
            return Err("this legacy marketplace item must be republished with a canister_hub.toml manifest".to_string());
        }
        item.downloads = item.downloads.saturating_add(1);
        items.insert(id, item);
        Ok(())
    })
}

fn icp_ledger_canister_id() -> Principal {
    Principal::from_text(ICP_LEDGER_CANISTER_ID).expect("canonical ICP ledger principal is valid")
}

fn marketplace_item_key(item: &MarketplaceItem) -> Result<(Principal, KeyName), String> {
    let (owner, repo) = parse_github_owner_repo(&item.git_repo_url)?;
    Ok(item_key_id(&format!("{owner}/{repo}"), &item.package_slug))
}

fn buyer_has_marketplace_access(
    buyer: Principal,
    key_id: (Principal, KeyName),
) -> Result<bool, String> {
    KEY_MANAGER.with(|km| {
        km.borrow()
            .get_user_rights(ic_cdk::api::canister_self(), key_id, buyer)
            .map(|rights| rights.is_some())
    })
}

fn grant_marketplace_read_access(
    buyer: Principal,
    key_id: (Principal, KeyName),
) -> Result<(), String> {
    KEY_MANAGER.with(|km| {
        km.borrow_mut()
            .set_user_rights(
                ic_cdk::api::canister_self(),
                key_id,
                buyer,
                AccessRights::Read,
            )
            .map(|_| ())
    })
}

fn paid_marketplace_item(
    item_id: u64,
) -> Result<(MarketplaceItem, u64, (Principal, KeyName)), String> {
    let item = ITEMS
        .with(|items| items.borrow().get(&item_id))
        .ok_or_else(|| format!("no marketplace item with id {item_id}"))?;
    if !is_current_marketplace_item(&item) {
        return Err(
            "this legacy marketplace item must be republished with a canister_hub.toml manifest"
                .to_string(),
        );
    }
    let amount_e8s = item
        .price
        .ok_or_else(|| "free marketplace items do not require a purchase".to_string())?;
    if item.encrypted_key.is_none() {
        return Err("paid marketplace item is missing its encrypted key".to_string());
    }
    let key_id = marketplace_item_key(&item)?;
    Ok((item, amount_e8s, key_id))
}

/// Returns whether the caller may download a paid marketplace item without
/// paying again. Completed payment records are authoritative even if the
/// subsequent access grant was interrupted; explicit publisher/controller
/// grants also count as access. Anonymous callers simply receive `false`, so
/// public marketplace pages can render their signed-out state without an
/// avoidable query error.
#[query]
fn has_purchased_marketplace_item(item_id: u64) -> Result<bool, String> {
    let buyer = ic_cdk::api::msg_caller();
    if buyer == Principal::anonymous() {
        return Ok(false);
    }

    let item = ITEMS
        .with(|items| items.borrow().get(&item_id))
        .ok_or_else(|| format!("no marketplace item with id {item_id}"))?;
    if !is_current_marketplace_item(&item) {
        return Err(
            "this legacy marketplace item must be republished with a canister_hub.toml manifest"
                .to_string(),
        );
    }
    if item.price.is_none() {
        return Ok(false);
    }

    let payment_confirmed = item
        .purchases
        .get(&buyer)
        .is_some_and(|purchase| purchase.block_height.is_some());
    if payment_confirmed {
        return Ok(true);
    }

    buyer_has_marketplace_access(buyer, marketplace_item_key(&item)?)
}

/// Pulls the exact listing price from the caller's approved ICP allowance and
/// grants that caller read access to the item's vetkey only after the ledger
/// confirms the transfer. Pending calls are journaled before the await, and a
/// retry accepts ICRC-2 `Duplicate` as the original successful payment.
#[update]
async fn purchase_marketplace_item(item_id: u64) -> Result<MarketplacePurchaseReceipt, String> {
    let buyer = ic_cdk::api::msg_caller();
    if buyer == Principal::anonymous() {
        return Err("authenticate before purchasing a marketplace item".to_string());
    }
    let (mut item, current_price_e8s, key_id) = paid_marketplace_item(item_id)?;
    let ledger_canister_id = icp_ledger_canister_id();
    let existing_purchase = item.purchases.get(&buyer).cloned();
    let amount_e8s = existing_purchase
        .as_ref()
        .map(|purchase| purchase.amount_e8s)
        .unwrap_or(current_price_e8s);

    if buyer_has_marketplace_access(buyer, key_id)? {
        let block_index = item
            .purchases
            .get(&buyer)
            .and_then(|purchase| purchase.block_height.clone());
        return Ok(MarketplacePurchaseReceipt {
            ledger_canister_id,
            amount_e8s,
            block_index,
            already_owned: true,
        });
    }

    if let Some(block_index) = item
        .purchases
        .get(&buyer)
        .and_then(|purchase| purchase.block_height.clone())
    {
        grant_marketplace_read_access(buyer, key_id)?;
        return Ok(MarketplacePurchaseReceipt {
            ledger_canister_id,
            amount_e8s,
            block_index: Some(block_index),
            already_owned: true,
        });
    }

    let created_at_time = existing_purchase
        .as_ref()
        .map(|purchase| purchase.created_at_time)
        .unwrap_or_else(ic_cdk::api::time);
    item.purchases.insert(
        buyer,
        MarketplacePurchase {
            created_at_time,
            amount_e8s,
            block_height: None,
        },
    );
    ITEMS.with(|items| {
        items.borrow_mut().insert(item_id, item.clone());
    });

    let args = TransferFromArgs {
        spender_subaccount: None,
        from: Account {
            owner: buyer,
            subaccount: None,
        },
        to: Account {
            owner: item.publisher,
            subaccount: None,
        },
        amount: Nat::from(amount_e8s),
        fee: None,
        memo: Some(Memo::from(item_id)),
        created_at_time: Some(created_at_time),
    };

    let response = Call::bounded_wait(ledger_canister_id, "icrc2_transfer_from")
        .with_arg(args)
        .await
        .map_err(|error| {
            format!(
                "ICP transfer_from outcome is not confirmed ({error:?}); retry purchase to safely resume"
            )
        })?;
    let (transfer_result,): (Result<Nat, TransferFromError>,) = response
        .candid_tuple()
        .map_err(|error| {
            format!(
                "could not decode ICP transfer_from response ({error:?}); retry purchase to safely resume"
            )
        })?;

    let block_index = match transfer_result {
        Ok(block_index) => block_index,
        Err(TransferFromError::Duplicate { duplicate_of }) => duplicate_of,
        Err(TransferFromError::TooOld) => {
            return Err(
                "ICP payment outcome is too old to retry safely; the purchase remains pending on the marketplace item to prevent a duplicate charge"
                    .to_string(),
            );
        }
        Err(error) => {
            return Err(format!(
                "ICP payment failed: {error}; retrying this item will reuse the same idempotent ledger transaction"
            ));
        }
    };

    // Reload after the await instead of writing the stale pre-await item: a
    // concurrent download or another buyer's purchase may have updated it.
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let mut current = items
            .get(&item_id)
            .ok_or_else(|| format!("marketplace item {item_id} disappeared during purchase"))?;
        current.purchases.insert(
            buyer,
            MarketplacePurchase {
                created_at_time,
                amount_e8s,
                block_height: Some(block_index.clone()),
            },
        );
        items.insert(item_id, current);
        Ok::<(), String>(())
    })?;
    grant_marketplace_read_access(buyer, key_id)?;

    Ok(MarketplacePurchaseReceipt {
        ledger_canister_id,
        amount_e8s,
        block_index: Some(block_index),
        already_owned: false,
    })
}

// ---------------------------------------------------------------------------
// Paid marketplace artifact key distribution (vetKD-backed)
//
// The functions below let this canister act as the license/key server for
// paid MarketplaceItem artifacts. Key material is derived on demand by the
// IC's threshold vetKD protocol and only leaves this canister encrypted to
// the requesting caller's transport key. This canister never has plaintext
// key material in memory. See the `vetkd` skill for the model this follows:
// https://skills.internetcomputer.org/.well-known/skills/vetkd/SKILL.md
// ---------------------------------------------------------------------------

// These five endpoints deliberately match the candid names/shapes of
// `ic_vetkeys::key_manager::KeyManager`'s own methods (see the `vetkd` skill
// and https://docs.rs/ic-vetkeys/latest/ic_vetkeys/key_manager/struct.KeyManager.html)
// rather than inventing bespoke ones. That's what lets the standalone,
// reusable GitHub Action in `vetkd-encrypt-action/` — and the official
// `@dfinity/vetkeys` `KeyManager`/`DefaultKeyManagerClient` frontend
// classes — talk to this canister with zero custom glue, and would do the
// same for any other project's KeyManager-backed canister. Internally, every
// method still enforces this canister's own narrower rules: every key is a
// registered marketplace repository's `item_key_id`, owned by this canister,
// and only a controller *or* the registered publisher of the
// marketplace item a key belongs to (see `KEY_NAME_OWNERS`) may grant or
// revoke access to it.

/// Checks that `owner` is this canister and `vetkey_name` belongs to a
/// registered marketplace repository. Arbitrary controller-created keys and
/// the former special app-Wasm key are deliberately rejected.
fn require_canister_owned_key(owner: Principal, vetkey_name: &ByteBuf) -> Result<KeyName, String> {
    let key_name = KeyName::try_from(vetkey_name.as_ref())
        .map_err(|_| "vetkeyName exceeds the 32-byte KeyName bound".to_string())?;
    if owner != ic_cdk::api::canister_self() {
        return Err("this canister only manages vetkeys it owns itself".to_string());
    }
    if !KEY_NAME_OWNERS.with(|owners| owners.borrow().contains_key(&key_name)) {
        return Err("vetkey is not registered to a marketplace repository".to_string());
    }
    Ok(key_name)
}

/// Whether `caller` may grant/revoke/inspect access to a given key: either a
/// canister controller acting as an administrative override, or the explicit
/// marketplace publisher stored in `KEY_NAME_OWNERS`.
fn can_manage_key(caller: Principal, key_name: &KeyName) -> bool {
    ic_cdk::api::is_controller(&caller)
        || KEY_NAME_OWNERS.with(|m| m.borrow().get(key_name)) == Some(caller)
}

/// Returns this canister's vetKD verification key, needed by clients to
/// authenticate (`decryptAndVerify`) whatever `get_encrypted_vetkey` returns.
/// Public and side-effect-free, but still `#[update]`: fetching it is itself
/// an inter-canister call to the management canister, which a `#[query]`
/// cannot make.
#[update]
async fn get_vetkey_verification_key() -> ByteBuf {
    let future = KEY_MANAGER.with(|km| km.borrow().get_vetkey_verification_key());
    future.await
}

/// Grants or modifies a principal's access to a marketplace item's
/// `item_key_id()` (its registered publisher, or a controller). Normal
/// marketplace purchases use `purchase_marketplace_item`, which grants
/// `Read` automatically only after its ICRC-2 payment succeeds; this method
/// remains the explicit administrative grant/override surface.
///
/// Unlike a single-use redemption token, this grant is durable: the caller
/// may derive the same key as many times as it needs to (re-installs,
/// multiple devices, a dropped download) until revoked via `remove_user`.
/// vetKD's derivation is idempotent — re-deriving costs cycles but never
/// changes what the key *is* — so there is no replay risk to guard against
/// the way there was when this canister held (and handed out copies of) the
/// raw key material itself.
#[update]
fn set_user_rights(
    owner: Principal,
    vetkey_name: ByteBuf,
    user: Principal,
    user_rights: AccessRights,
) -> Result<Option<AccessRights>, String> {
    let caller = ic_cdk::api::msg_caller();
    let key_name = require_canister_owned_key(owner, &vetkey_name)?;
    if !can_manage_key(caller, &key_name) {
        return Err(
            "only a controller or this key's verified publisher may modify access to it"
                .to_string(),
        );
    }
    if user == Principal::anonymous() {
        return Err("cannot grant access to the anonymous principal".to_string());
    }
    KEY_MANAGER.with(|km| {
        km.borrow_mut().set_user_rights(
            ic_cdk::api::canister_self(),
            (owner, key_name),
            user,
            user_rights,
        )
    })
}

/// Revokes a principal's access to a vetkey this canister manages (e.g.
/// after a refund or chargeback). Same authorization as `set_user_rights`.
#[update]
fn remove_user(
    owner: Principal,
    vetkey_name: ByteBuf,
    user: Principal,
) -> Result<Option<AccessRights>, String> {
    let caller = ic_cdk::api::msg_caller();
    let key_name = require_canister_owned_key(owner, &vetkey_name)?;
    if !can_manage_key(caller, &key_name) {
        return Err(
            "only a controller or this key's verified publisher may revoke access to it"
                .to_string(),
        );
    }
    KEY_MANAGER.with(|km| {
        km.borrow_mut()
            .remove_user(ic_cdk::api::canister_self(), (owner, key_name), user)
    })
}

/// Reports a principal's access rights to a vetkey this canister manages.
/// Same authorization as `set_user_rights` (this canister has no
/// self-service "check my own rights" path — attempt `get_encrypted_vetkey`
/// instead, which will simply fail for an unauthorized caller).
#[query]
fn get_user_rights(
    owner: Principal,
    vetkey_name: ByteBuf,
    user: Principal,
) -> Result<Option<AccessRights>, String> {
    let caller = ic_cdk::api::msg_caller();
    let key_name = require_canister_owned_key(owner, &vetkey_name)?;
    if !can_manage_key(caller, &key_name) {
        return Err(
            "only a controller or this key's verified publisher may inspect access to it"
                .to_string(),
        );
    }
    KEY_MANAGER.with(|km| {
        km.borrow()
            .get_user_rights(ic_cdk::api::canister_self(), (owner, key_name), user)
    })
}

/// Lists the marketplace (owner, vetkeyName) pairs shared with the caller
/// that they still have access to.
#[query]
fn get_accessible_shared_key_ids() -> Vec<(Principal, ByteBuf)> {
    let caller = ic_cdk::api::msg_caller();
    KEY_MANAGER
        .with(|km| km.borrow().get_accessible_shared_key_ids(caller))
        .into_iter()
        .map(|(owner, name)| (owner, ByteBuf::from(name.as_ref().to_vec())))
        .collect()
}

/// Issues the decryption vetkey for a marketplace item's `item_key_id()` to
/// a verified caller, wrapped under the
/// client-supplied vetKD transport public key so only that client can
/// decrypt it (see `@dfinity/vetkeys`' `TransportSecretKey` /
/// `EncryptedVetKey.decryptAndVerify`, or the Rust equivalent, on the caller
/// side — pair with `get_vetkey_verification_key` for verification).
#[update]
async fn get_encrypted_vetkey(
    key_owner: Principal,
    vetkey_name: ByteBuf,
    transport_key: ByteBuf,
) -> Result<ByteBuf, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err("anonymous callers may not request a decryption key".to_string());
    }
    if transport_key.as_ref().len() != VETKD_TRANSPORT_PUBLIC_KEY_BYTES {
        return Err(format!(
            "transport_key must be a {VETKD_TRANSPORT_PUBLIC_KEY_BYTES}-byte vetKD transport public key"
        ));
    }
    let key_name = require_canister_owned_key(key_owner, &vetkey_name)?;

    // `get_encrypted_vetkey` checks `caller`'s access rights — granted via
    // `set_user_rights` — against this specific key synchronously (see
    // `KeyManager::ensure_user_can_read`) *before* returning the future that
    // actually performs the inter-canister `vetkd_derive_key` call — so an
    // unauthorized caller is rejected here, ahead of any `await`, without
    // spending cycles on a doomed derivation.
    let future = KEY_MANAGER.with(|km| {
        km.borrow()
            .get_encrypted_vetkey(caller, (key_owner, key_name), transport_key)
    })?;
    Ok(future.await)
}

// ---------------------------------------------------------------------------
// API access tokens (JWT)
//
// Internet Identity gives a caller a *principal*, verifiable inter-canister
// and by this canister itself, but says nothing to an off-chain HTTP service
// (the orchestrator) about who's calling it — II delegations aren't bearer
// tokens an HTTP client can just attach to a request. `issue_jwt` bridges
// that: a caller who can already prove their principal to *this* canister
// (an authenticated update call) gets back a short-lived HS256 JWT binding
// that principal, which they then send as `Authorization: Bearer <token>` to
// the orchestrator. The orchestrator verifies it itself (it fetches this same
// signing key once, as a controller, via `get_jwt_signing_key` — see
// `services/orchestrator/src/auth.rs`) without round-tripping back to this canister on
// every HTTP request.
// ---------------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

const JWT_HEADER_JSON: &str = r#"{"alg":"HS256","typ":"JWT"}"#;

/// One-time setup: generates this canister's JWT signing key from `raw_rand`
/// (the IC's own verifiable randomness — not `getrandom`, which this canister
/// can't use; see the top of this file) and stores it in stable memory.
///
/// Deliberately not "generate lazily on first `issue_jwt` call": two callers
/// racing to be first would each see no key set, each trigger a generation,
/// and whichever write loses would silently invalidate any token already
/// issued off the other's key. An explicit, controller-only, one-time,
/// idempotent-by-rejection setup step avoids that without needing a mutex
/// primitive this single-threaded canister doesn't have anyway.
#[update]
async fn init_jwt_signing_key() -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may initialize JWT signing".to_string());
    }
    let already_initialized = JWT_SIGNING_KEY.with(|k| !k.borrow().get().is_empty());
    if already_initialized {
        return Err("JWT signing key is already initialized".to_string());
    }
    let randomness = raw_rand()
        .await
        .map_err(|e| format!("raw_rand failed: {e}"))?;
    // Updates can interleave while awaiting raw_rand. Recheck here so two
    // concurrent controller calls cannot overwrite each other and invalidate
    // tokens signed with the first key.
    JWT_SIGNING_KEY.with(|k| {
        let mut key = k.borrow_mut();
        if !key.get().is_empty() {
            return Err("JWT signing key was initialized by another call".to_string());
        }
        key.set(randomness);
        Ok(())
    })
}

/// Lets the orchestrator (or any other controller-run verifier) fetch this
/// canister's JWT signing key once and verify tokens locally from then on,
/// instead of calling back into this canister on every HTTP request it
/// serves. This is controller-only because it is a symmetric key, so anyone
/// who can read it can forge tokens for any principal.
#[query]
fn get_jwt_signing_key() -> Result<Vec<u8>, String> {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may read the JWT signing key".to_string());
    }
    let key = JWT_SIGNING_KEY.with(|k| k.borrow().get().clone());
    if key.is_empty() {
        return Err(
            "JWT signing key is not initialized — ask a controller to call init_jwt_signing_key"
                .to_string(),
        );
    }
    Ok(key)
}

/// Issues a short-lived (`JWT_TTL_SECS`) HS256 JWT binding `msg_caller()`,
/// for the caller to present as a bearer token to the orchestrator's HTTP
/// API. `#[update]`, not `#[query]`, so `msg_caller()` reflects a properly
/// authenticated (consensus-certified) call rather than an unsigned fast
/// query anyone could send as anyone — same reasoning as
/// `register_repo_publisher` and `get_encrypted_vetkey` above.
#[update]
fn issue_jwt() -> Result<String, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err(
            "anonymous callers may not request a token — authenticate with Internet Identity first"
                .to_string(),
        );
    }
    let key = JWT_SIGNING_KEY.with(|k| k.borrow().get().clone());
    if key.is_empty() {
        return Err(
            "JWT signing is not initialized — ask a controller to call init_jwt_signing_key"
                .to_string(),
        );
    }

    let iat = ic_cdk::api::time() / 1_000_000_000;
    let exp = iat + JWT_TTL_SECS;
    // `caller.to_text()` / `canister_self().to_text()` are base32 + hyphens
    // only (RFC 3548 alphabet plus separators), so this is safe to splice
    // into a JSON string literal without an escaper.
    let payload_json = format!(
        r#"{{"sub":"{}","iss":"{}","iat":{iat},"exp":{exp}}}"#,
        caller.to_text(),
        ic_cdk::api::canister_self().to_text(),
    );

    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(JWT_HEADER_JSON),
        URL_SAFE_NO_PAD.encode(payload_json),
    );
    let mut mac = HmacSha256::new_from_slice(&key).expect("HMAC-SHA256 accepts any key length");
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{signing_input}.{signature}"))
}

/// Creates a new `Project` record - called directly by the frontend, as the
/// signed-in user themselves. The orchestrator has no part in this at all
/// (see the `decouple-orchestrator-api` project notes): `backend` is a
/// self-service data store the real end user writes to directly, using the
/// same identity every other direct-to-canister call in this dashboard
/// already uses - so the owner is simply `msg_caller()`, not a value
/// asserted on the caller's behalf by some other authenticated party.
#[update]
fn create_project(id: String, request: String, network: String) -> Result<(), String> {
    let caller = require_authenticated_caller("create a project")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_text_size("project request", &request, MAX_PROJECT_REQUEST_BYTES)?;
    ensure_text_size("project network", &network, MAX_PROJECT_NETWORK_BYTES)?;
    if id.trim().is_empty() {
        return Err("project id must not be empty".to_string());
    }
    if network.trim().is_empty() {
        return Err("project network must not be empty".to_string());
    }
    if PROJECTS.with(|p| p.borrow().contains_key(&id)) {
        return Err(format!("project {id} already exists"));
    }
    let now = ic_cdk::api::time();
    let project = Project {
        id: id.clone(),
        request,
        network,
        owner: caller,
        state: ProjectState::Running,
        pending_question: None,
        project_name: None,
        canisters: std::collections::BTreeMap::new(),
        llm_context: None,
        final_message: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    PROJECTS.with(|p| p.borrow_mut().insert(id, project));
    Ok(())
}

/// Updates a project's state - `Running`/`AwaitingAnswer` transitions, with
/// `pending_question` set exactly when `state == AwaitingAnswer`. Owner-gated,
/// same shape as `remove_project_canister` below - called directly by the
/// frontend on its own project, never the orchestrator (see this file's
/// "Project tracking" section doc note).
#[update]
fn update_project_state(
    id: String,
    state: ProjectState,
    pending_question: Option<String>,
) -> Result<(), String> {
    let caller = require_authenticated_caller("update a project")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_optional_text_size(
        "pending question",
        pending_question.as_ref(),
        MAX_PENDING_QUESTION_BYTES,
    )?;
    if matches!(state, ProjectState::AwaitingAnswer) != pending_question.is_some() {
        return Err(
            "pending_question must be set exactly when state is AwaitingAnswer".to_string(),
        );
    }
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;
        project.state = state;
        project.pending_question = pending_question;
        project.updated_at = ic_cdk::api::time();
        projects.insert(id.clone(), project);
        Ok(())
    })
}

/// Records a project's own chosen name. Owner-gated, same shape as
/// `remove_project_canister` below.
#[update]
fn set_project_name(id: String, project_name: String) -> Result<(), String> {
    let caller = require_authenticated_caller("rename a project")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_text_size("project name", &project_name, MAX_PROJECT_NAME_BYTES)?;
    if project_name.trim().is_empty() {
        return Err("project name must not be empty".to_string());
    }
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;
        project.project_name = Some(project_name);
        project.updated_at = ic_cdk::api::time();
        projects.insert(id, project);
        Ok(())
    })
}

/// Reads the authenticated owner's saved project notification preference.
#[query]
fn get_project_notification_preferences(
    id: String,
) -> Result<ProjectNotificationPreferences, String> {
    let caller = require_authenticated_caller("read project notification settings")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    let is_owner = PROJECTS
        .with(|projects| projects.borrow().get(&id))
        .is_some_and(|project| project.owner == caller);
    if !is_owner {
        return Err(format!("no project with id {id}"));
    }
    Ok(ProjectNotificationPreferences {
        push_enabled: PROJECT_NOTIFICATION_PREFERENCES.with(|preferences| {
            preferences
                .borrow()
                .get(&id)
                .unwrap_or(true)
        }),
    })
}

/// Saves the authenticated owner's project-wide Web Push preference.
#[update]
fn set_project_notification_preferences(id: String, push_enabled: bool) -> Result<(), String> {
    let caller = require_authenticated_caller("change project notification settings")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    let is_owner = PROJECTS.with(|projects| {
        projects
            .borrow()
            .get(&id)
            .is_some_and(|project| project.owner == caller)
    });
    if !is_owner {
        return Err(format!("no project with id {id}"));
    }
    PROJECT_NOTIFICATION_PREFERENCES.with(|preferences| {
        preferences.borrow_mut().insert(id, push_enabled);
    });
    Ok(())
}

/// Merges newly deployed canister ids into a project's running set.
/// Additive, never replacing: called at every point a canister id becomes
/// known (e.g. right after the frontend's own direct `install_code` call
/// succeeds - see `lib/deploy.ts`), so a project's `canisters` map is
/// always the complete, current record - the only thing telling the
/// dashboard which canisters exist to call directly. Owner-gated, same
/// shape as `remove_project_canister` below.
#[update]
fn add_project_canisters(id: String, canisters: Vec<(String, CanisterInfo)>) -> Result<(), String> {
    let caller = require_authenticated_caller("add project canisters")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    if canisters.len() > MAX_PROJECT_CANISTERS {
        return Err(format!(
            "too many canisters in one request (maximum {MAX_PROJECT_CANISTERS})"
        ));
    }
    for (name, _) in &canisters {
        ensure_text_size("canister name", name, MAX_CANISTER_NAME_BYTES)?;
        if name.trim().is_empty() {
            return Err("canister name must not be empty".to_string());
        }
    }
    for (_, info) in &canisters {
        if let Some(package_name) = &info.package_name {
            let known = PACKAGE_INFOS.with(|packages| {
                packages
                    .borrow()
                    .iter()
                    .any(|entry| entry.value().name == *package_name)
            });
            if !known {
                return Err(format!("unknown package name '{package_name}'"));
            }
        }
    }
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;

        // Retries may enrich a legacy `{id, kind}` entry with its package name,
        // but may never change the canister identity, kind, or an already
        // assigned package. Omitting package_name on a later retry preserves it.
        for (name, info) in &canisters {
            if let Some(existing) = project.canisters.get(name) {
                let package_conflicts = existing.package_name.is_some()
                    && info.package_name.is_some()
                    && existing.package_name != info.package_name;
                if existing.id != info.id || existing.kind != info.kind || package_conflicts {
                    return Err(format!(
                        "project already tracks a different canister as '{name}'"
                    ));
                }
            }
        }
        let new_names = canisters
            .iter()
            .filter(|(name, _)| !project.canisters.contains_key(name))
            .map(|(name, _)| name)
            .collect::<BTreeSet<_>>()
            .len();
        if project.canisters.len().saturating_add(new_names) > MAX_PROJECT_CANISTERS {
            return Err(format!(
                "a project may track at most {MAX_PROJECT_CANISTERS} canisters"
            ));
        }
        for (name, mut info) in canisters {
            if let Some(existing) = project.canisters.get(&name) {
                if info.package_name.is_none() {
                    info.package_name.clone_from(&existing.package_name);
                }
            }
            project.canisters.insert(name, info);
        }
        project.updated_at = ic_cdk::api::time();
        projects.insert(id, project);
        Ok(())
    })
}

/// Records a project-wide LLM context document. Owner-gated, same shape as
/// `remove_project_canister` below.
#[update]
fn set_project_llm_context(id: String, context: String) -> Result<(), String> {
    let caller = require_authenticated_caller("update project context")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_text_size("LLM context", &context, MAX_LLM_CONTEXT_BYTES)?;
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;
        project.llm_context = Some(context);
        project.updated_at = ic_cdk::api::time();
        projects.insert(id, project);
        Ok(())
    })
}

/// Marks a project finished - `Succeeded` if `error` is `None`, `Failed`
/// otherwise. Clears any pending question. Owner-gated, same shape as
/// `remove_project_canister` below.
#[update]
fn finish_project(
    id: String,
    final_message: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let caller = require_authenticated_caller("finish a project")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_optional_text_size(
        "final message",
        final_message.as_ref(),
        MAX_PROJECT_RESULT_BYTES,
    )?;
    ensure_optional_text_size("project error", error.as_ref(), MAX_PROJECT_RESULT_BYTES)?;
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;
        project.state = if error.is_some() {
            ProjectState::Failed
        } else {
            ProjectState::Succeeded
        };
        project.pending_question = None;
        project.final_message = final_message;
        project.error = error;
        project.updated_at = ic_cdk::api::time();
        projects.insert(id, project);
        Ok(())
    })
}

/// Drops one canister from a project's tracked set - the owner's own
/// counterpart to `add_project_canisters`. Called directly by the frontend
/// right after its own direct `delete_canister` management-canister call
/// succeeds, so this project's record doesn't keep pointing at a canister
/// id that no longer exists. Same "indistinguishable from not existing"
/// non-owner behavior as `get_project`. A `name` that isn't currently
/// tracked is not an error - the end state (not tracked) is already what
/// was asked for.
#[update]
fn remove_project_canister(id: String, name: String) -> Result<(), String> {
    let caller = require_authenticated_caller("remove a project canister")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    ensure_text_size("canister name", &name, MAX_CANISTER_NAME_BYTES)?;
    let removed = PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        let mut project = projects
            .get(&id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {id}"))?;
        let removed = project.canisters.remove(&name);
        project.updated_at = ic_cdk::api::time();
        projects.insert(id.clone(), project);
        Ok::<Option<CanisterInfo>, String>(removed)
    })?;
    if let Some(info) = removed {
        package_registry::remove_project_canister_install(&id, info.id);
    }
    Ok(())
}

/// Permanently deletes a project's own record - the Settings page's "Delete
/// Project" (Danger Zone). Owner-gated, same "indistinguishable from not
/// existing" behavior as `get_project`/`remove_project_canister`.
///
/// Deliberately does **not** touch any real IC canister - a `Project` here
/// is only ever a *record of* canisters this canister never itself
/// controls or could reach. Deleting it just stops tracking whatever it
/// still names; any canister still listed in `canisters` keeps running,
/// keeps burning cycles, and becomes unreachable from this dashboard the
/// moment this call succeeds (no other project will ever list it). This
/// canister has no way to know whether that's actually fine, so it doesn't
/// second-guess the caller - `frontend/src/pages/Settings.tsx` is what
/// requires `canisters` be empty first, as its own disclosed, deliberate
/// safety rule, not something enforced here.
#[update]
fn delete_project(id: String) -> Result<(), String> {
    let caller = require_authenticated_caller("delete a project")?;
    ensure_text_size("project id", &id, MAX_PROJECT_ID_BYTES)?;
    PROJECTS.with(|p| {
        let mut projects = p.borrow_mut();
        if projects
            .get(&id)
            .is_none_or(|project| project.owner != caller)
        {
            return Err(format!("no project with id {id}"));
        }
        projects.remove(&id);
        Ok(())
    })?;
    package_registry::remove_project_installs(&id);
    Ok(())
}

/// Fetches one project by id - but only for its own owner (see `Project::owner`'s
/// doc comment). Returns `None` for a non-owner caller, indistinguishable
/// from the project not existing at all, rather than an error revealing that
/// it does.
#[query]
fn get_project(id: String) -> Option<Project> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() || id.len() > MAX_PROJECT_ID_BYTES {
        return None;
    }
    PROJECTS
        .with(|p| p.borrow().get(&id))
        .filter(|project| project.owner == caller)
        .map(hydrate_project_package_names)
}

/// Verifies project membership for a package-to-package authorization check.
/// The calling canister and the requested package must both be present in the
/// backend's current project record, so callers cannot use this as an oracle
/// for projects they do not belong to.
#[update]
fn verify_project_package_membership(
    project_id: String,
    package_id: Principal,
) -> Result<bool, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Err("anonymous callers cannot verify project package membership".to_string());
    }
    ensure_text_size("project id", &project_id, MAX_PROJECT_ID_BYTES)?;
    let is_member = PROJECTS.with(|projects| {
        projects.borrow().get(&project_id).is_some_and(|project| {
            let contains = |id| project.canisters.values().any(|info| info.id == id);
            contains(caller) && contains(package_id)
        })
    });
    Ok(is_member)
}

fn hydrate_project_package_names(mut project: Project) -> Project {
    for canister in project.canisters.values_mut() {
        if canister.package_name.is_none() {
            canister.package_name =
                package_registry::project_canister_package_name(&project.id, canister.id);
        }
    }
    project
}

/// Every project the caller owns, newest first - mirrors
/// `orchestrator::job::JobStore::list_for`. The real data behind the
/// dashboard's project list, called directly - no orchestrator HTTP call.
#[query]
fn list_my_projects() -> Vec<Project> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Vec::new();
    }
    let mut projects: Vec<Project> = PROJECTS.with(|p| {
        p.borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|project| project.owner == caller)
            .map(hydrate_project_package_names)
            .collect()
    });
    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    projects
}

ic_cdk::export_candid!();
