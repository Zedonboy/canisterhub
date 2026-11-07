use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// One canister already installed in the project, identified by the stable
/// Wasm artifact filename assigned by the package registry.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProjectCanister {
    pub canister_id: Principal,
    pub package_name: String,
}

/// Platform-owned context supplied when a package is installed.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectContext {
    pub project_id: String,
    pub canisters: Vec<ProjectCanister>,
}

impl ProjectContext {
    pub fn canister_for_package(&self, package_name: &str) -> Option<Principal> {
        let package_name = package_name.trim();
        self.canisters
            .iter()
            .find(|canister| {
                canister
                    .package_name
                    .trim()
                    .eq_ignore_ascii_case(package_name)
            })
            .map(|canister| canister.canister_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_canisters_by_package_artifact_name() {
        let expected = Principal::from_slice(&[7; 10]);
        let context = ProjectContext {
            project_id: "project-1".to_string(),
            canisters: vec![ProjectCanister {
                canister_id: expected,
                package_name: "assetstorage.wasm".to_string(),
            }],
        };
        assert_eq!(
            context.canister_for_package("ASSETSTORAGE.WASM"),
            Some(expected)
        );
    }
}
