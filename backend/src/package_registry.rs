//! Stable package release catalog and per-project installation snapshots.
//!
//! Catalog entries describe the current release. Installation rows preserve
//! the exact version/SHA that was installed, so changing a catalog entry turns
//! into an explicit update signal instead of silently rewriting project state.

use candid::{CandidType, Principal};
use ic_stable_structures::{storable::Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeSet;

use crate::{
    ensure_text_size, require_authenticated_caller, validate_package_slug, PACKAGE_INFOS, PROJECTS,
    PROJECT_PACKAGE_INSTALLS,
};

const MAX_PACKAGE_VERSION_BYTES: usize = 64;
const SHA256_HEX_BYTES: usize = 64;
const MAX_SEED_PACKAGES: usize = 100;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageInfoInput {
    pub description: String,
    pub url: String,
    pub version: String,
    pub sha: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub url: String,
    pub version: String,
    /// Lowercase hexadecimal SHA-256 of the exact Wasm bytes at `url`.
    pub sha: String,
}

impl Storable for PackageInfo {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode PackageInfo"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).expect("failed to decode PackageInfo")
    }
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledPackage {
    pub project_id: String,
    pub canister_name: String,
    pub canister_id: Principal,
    pub package_name: String,
    pub version: String,
    pub sha: String,
    pub installed_at: u64,
}

#[derive(CandidType, Deserialize)]
struct LegacyInstalledPackage {
    project_id: String,
    canister_name: String,
    canister_id: Principal,
    package_id: String,
    version: String,
    sha: String,
    installed_at: u64,
}

impl Storable for InstalledPackage {
    const BOUND: Bound = Bound::Unbounded;

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("failed to encode InstalledPackage"))
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(bytes.as_ref()).unwrap_or_else(|_| {
            let legacy: LegacyInstalledPackage =
                candid::decode_one(bytes.as_ref()).expect("failed to decode InstalledPackage");
            InstalledPackage {
                project_id: legacy.project_id,
                canister_name: legacy.canister_name,
                canister_id: legacy.canister_id,
                // Resolved from the old internal id to the artifact name when read.
                package_name: legacy.package_id,
                version: legacy.version,
                sha: legacy.sha,
                installed_at: legacy.installed_at,
            }
        })
    }
}

fn resolve_legacy_package_name(mut install: InstalledPackage) -> InstalledPackage {
    if !install.package_name.ends_with(".wasm") {
        if let Some(package) =
            PACKAGE_INFOS.with(|packages| packages.borrow().get(&install.package_name))
        {
            install.package_name = package.name;
        }
    }
    install
}

fn installation_key(project_id: &str, canister_id: Principal) -> String {
    // Length-prefixing makes this unambiguous even if a caller-created project
    // id contains punctuation used by Principal text.
    format!(
        "{}:{project_id}:{}",
        project_id.len(),
        canister_id.to_text()
    )
}

fn hyphenated_title(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_hyphen = false;
    for character in title.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character);
            pending_hyphen = false;
        } else {
            pending_hyphen = !slug.is_empty();
        }
        if slug.len() >= 35 {
            break;
        }
    }
    slug.trim_end_matches('-').to_string()
}

fn random_package_id(title: &str, randomness: &[u8]) -> Result<String, String> {
    let slug = hyphenated_title(title);
    if slug.is_empty() {
        return Err("package name must contain an ASCII letter or number".to_string());
    }
    let random_hex = randomness
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let id = format!("{slug}-{random_hex}");
    validate_package_slug(&id)?;
    Ok(id)
}

/// Stable package identity exposed to module schemas: the final filename in
/// the download URL, including `.wasm` (for example `agent.wasm`).
fn package_name_from_url(url: &str) -> Result<&str, String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "package URL must end with a .wasm filename".to_string())?;
    if name != name.to_ascii_lowercase()
        || !name.ends_with(".wasm")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err("package URL must end with a safe lowercase .wasm filename".to_string());
    }
    Ok(name)
}

fn validate_package_info(info: &PackageInfoInput) -> Result<(), String> {
    ensure_text_size(
        "package description",
        &info.description,
        crate::MAX_MARKETPLACE_DESCRIPTION_BYTES,
    )?;
    ensure_text_size("package URL", &info.url, crate::MAX_URL_BYTES)?;
    ensure_text_size("package version", &info.version, MAX_PACKAGE_VERSION_BYTES)?;

    if info.description.trim().is_empty() {
        return Err("package description must not be empty".to_string());
    }
    if !info.url.starts_with("https://") {
        return Err("package URL must use HTTPS".to_string());
    }
    let artifact_name = package_name_from_url(&info.url)?;
    ensure_text_size(
        "package name",
        artifact_name,
        crate::MAX_MARKETPLACE_TITLE_BYTES,
    )?;
    if info.version.trim().is_empty() {
        return Err("package version must not be empty".to_string());
    }
    if info.sha.len() != SHA256_HEX_BYTES
        || !info
            .sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("package sha must be a lowercase 64-character SHA-256 hex digest".to_string());
    }
    Ok(())
}

/// Adds or replaces current official package releases in one atomic update.
/// New packages receive `<hyphenated-title>-<raw_rand hex>` ids. Uploading a
/// new release under the same hyphenated title retains the existing id.
#[ic_cdk::update]
async fn upload_package_infos(infos: Vec<PackageInfoInput>) -> Result<Vec<PackageInfo>, String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() || !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may seed package information".to_string());
    }
    if infos.is_empty() {
        return Err("at least one package is required".to_string());
    }
    if infos.len() > MAX_SEED_PACKAGES {
        return Err(format!(
            "too many packages in one request (maximum {MAX_SEED_PACKAGES})"
        ));
    }

    let mut titles = BTreeSet::new();
    for info in &infos {
        validate_package_info(info)?;
        let title = hyphenated_title(package_name_from_url(&info.url)?);
        if !titles.insert(title.clone()) {
            return Err(format!("duplicate hyphenated package title '{title}'"));
        }
    }

    // Fetch randomness before mutating stable state. Recheck controller status
    // after the await because canister settings may change while suspended.
    let mut random_values = Vec::with_capacity(infos.len());
    for _ in &infos {
        random_values.push(
            ic_cdk::management_canister::raw_rand()
                .await
                .map_err(|error| format!("raw_rand failed while assigning package id: {error}"))?,
        );
    }
    if !ic_cdk::api::is_controller(&caller) {
        return Err("caller is no longer a controller".to_string());
    }

    PACKAGE_INFOS.with(|packages| -> Result<Vec<PackageInfo>, String> {
        let mut packages = packages.borrow_mut();
        let mut stored = Vec::with_capacity(infos.len());
        for (info, randomness) in infos.into_iter().zip(random_values) {
            let package_name = package_name_from_url(&info.url)?.to_string();
            let title_slug = hyphenated_title(&package_name);
            let existing_id = packages.iter().find_map(|entry| {
                let existing = entry.value();
                let same_artifact =
                    package_name_from_url(&existing.url).is_ok_and(|name| name == package_name);
                (same_artifact || hyphenated_title(&existing.name) == title_slug)
                    .then(|| entry.key().clone())
            });
            let is_new = existing_id.is_none();
            let id = match existing_id {
                Some(id) => id,
                None => random_package_id(&package_name, &randomness)?,
            };
            if is_new && packages.contains_key(&id) {
                return Err("generated package id collided; retry the upload".to_string());
            }
            let package = PackageInfo {
                id: id.clone(),
                name: package_name,
                description: info.description,
                url: info.url,
                version: info.version,
                sha: info.sha,
            };
            packages.insert(id, package.clone());
            stored.push(package);
        }
        Ok(stored)
    })
}

/// Retained only for Candid compatibility with clients generated before IDs
/// became backend-assigned. Accepting caller-chosen IDs here would violate the
/// new identity invariant, so callers must migrate to `upload_package_infos`.
#[ic_cdk::update]
fn seed_package_infos(_infos: Vec<PackageInfo>) -> Result<(), String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() || !ic_cdk::api::is_controller(&caller) {
        return Err("only a controller may seed package information".to_string());
    }
    Err("package ids are assigned by the backend; use upload_package_infos".to_string())
}

#[ic_cdk::query]
fn list_package_infos() -> Vec<PackageInfo> {
    PACKAGE_INFOS.with(|packages| {
        packages
            .borrow()
            .iter()
            .map(|entry| entry.value())
            .collect()
    })
}

#[ic_cdk::query]
fn get_package_info(package_name: String) -> Option<PackageInfo> {
    PACKAGE_INFOS.with(|packages| {
        let packages = packages.borrow();
        packages
            .iter()
            .find_map(|entry| (entry.value().name == package_name).then(|| entry.value()))
            // Compatibility for callers holding the old internal id.
            .or_else(|| packages.get(&package_name))
    })
}

/// Records the catalog snapshot installed in one already-tracked project
/// canister. The backend derives version and SHA from its own catalog, so a
/// browser cannot claim arbitrary installed bytes.
#[ic_cdk::update]
fn record_project_package_installation(
    project_id: String,
    canister_name: String,
    package_name: String,
) -> Result<InstalledPackage, String> {
    let caller = require_authenticated_caller("record a package installation")?;
    ensure_text_size("project id", &project_id, crate::MAX_PROJECT_ID_BYTES)?;
    ensure_text_size(
        "canister name",
        &canister_name,
        crate::MAX_CANISTER_NAME_BYTES,
    )?;

    let package = PACKAGE_INFOS
        .with(|packages| {
            packages
                .borrow()
                .iter()
                .find_map(|entry| (entry.value().name == package_name).then(|| entry.value()))
        })
        .ok_or_else(|| format!("unknown package name '{package_name}'"))?;
    let canister = PROJECTS.with(|projects| {
        let mut projects = projects.borrow_mut();
        let mut project = projects
            .get(&project_id)
            .filter(|project| project.owner == caller)
            .ok_or_else(|| format!("no project with id {project_id}"))?;
        let mut canister = project
            .canisters
            .get(&canister_name)
            .cloned()
            .ok_or_else(|| format!("project does not track canister '{canister_name}'"))?;
        if canister
            .package_name
            .as_ref()
            .is_some_and(|existing| existing != &package_name)
        {
            return Err(format!(
                "canister '{canister_name}' is already associated with a different package"
            ));
        }
        canister.package_name = Some(package_name.clone());
        project
            .canisters
            .insert(canister_name.clone(), canister.clone());
        project.updated_at = ic_cdk::api::time();
        projects.insert(project_id.clone(), project);
        Ok(canister)
    })?;

    let installed = InstalledPackage {
        project_id: project_id.clone(),
        canister_name,
        canister_id: canister.id,
        package_name,
        version: package.version,
        sha: package.sha,
        installed_at: ic_cdk::api::time(),
    };
    PROJECT_PACKAGE_INSTALLS.with(|installs| {
        installs.borrow_mut().insert(
            installation_key(&project_id, canister.id),
            installed.clone(),
        );
    });
    Ok(installed)
}

#[ic_cdk::query]
fn list_project_package_installations(project_id: String) -> Result<Vec<InstalledPackage>, String> {
    let caller = require_authenticated_caller("list package installations")?;
    let owned = PROJECTS.with(|projects| {
        projects
            .borrow()
            .get(&project_id)
            .is_some_and(|project| project.owner == caller)
    });
    if !owned {
        return Err(format!("no project with id {project_id}"));
    }

    Ok(PROJECT_PACKAGE_INSTALLS.with(|installs| {
        installs
            .borrow()
            .iter()
            .map(|entry| resolve_legacy_package_name(entry.value()))
            .filter(|install| install.project_id == project_id)
            .collect()
    }))
}

pub(crate) fn project_canister_package_name(
    project_id: &str,
    canister_id: Principal,
) -> Option<String> {
    PROJECT_PACKAGE_INSTALLS.with(|installs| {
        installs
            .borrow()
            .get(&installation_key(project_id, canister_id))
            .map(resolve_legacy_package_name)
            .map(|install| install.package_name)
    })
}

pub(crate) fn remove_project_canister_install(project_id: &str, canister_id: Principal) {
    PROJECT_PACKAGE_INSTALLS.with(|installs| {
        installs
            .borrow_mut()
            .remove(&installation_key(project_id, canister_id));
    });
}

pub(crate) fn remove_project_installs(project_id: &str) {
    let keys = PROJECT_PACKAGE_INSTALLS.with(|installs| {
        installs
            .borrow()
            .iter()
            .filter_map(|entry| {
                (entry.value().project_id == project_id).then(|| entry.key().clone())
            })
            .collect::<Vec<_>>()
    });
    PROJECT_PACKAGE_INSTALLS.with(|installs| {
        let mut installs = installs.borrow_mut();
        for key in keys {
            installs.remove(&key);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(url: &str) -> PackageInfoInput {
        PackageInfoInput {
            description: "A useful business package".to_string(),
            url: url.to_string(),
            version: "1.0.0".to_string(),
            sha: "a".repeat(64),
        }
    }

    #[test]
    fn package_name_is_the_wasm_filename_from_the_url() {
        let info = input("https://example.com/releases/v1/order_inventory.wasm");
        assert!(validate_package_info(&info).is_ok());

        let invalid = input("https://example.com/releases/v1/Order Inventory.wasm");
        assert!(validate_package_info(&invalid).is_err());
    }
}
