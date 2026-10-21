//! This canister's one runtime setting - whether to consult an `auth`
//! canister for callers with no explicit local permission entry (see
//! `auth.rs`'s module doc comment for the full access-control model).
//!
//! `update_config` takes a separate `ConfigUpdate`, not a whole `Config` -
//! same three-state-per-field convention as every other building block's
//! `ConfigUpdate` here (e.g. `connector::config::ConfigUpdate`'s doc
//! comment): outer `None` leaves the field untouched, `Some(None)` clears
//! it, `Some(Some(value))` sets it.

use candid::{CandidType, Principal};
use canister_hub_sdk::ic::config::DynamicConfig;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq, DynamicConfig)]
#[config_urls(admin_panel_url = "/admin/")]
pub struct Config {
    /// The `auth` canister (see that crate) to consult for a caller with no
    /// explicit `set_permission` entry of their own - `None` (the default)
    /// means every such caller falls back to `ReadWrite`, the same
    /// no-access-control behavior this canister had before this field
    /// existed. See `auth::decide`'s doc comment for exactly how this
    /// combines with an explicit permission entry.
    #[config(
        label = "Auth Canister",
        description = "Canister used to authenticate callers and resolve row-level security subjects",
        canister_type = "auth"
    )]
    pub auth_canister: Option<Principal>,
}

/// `update_config`'s argument - see this module's doc comment for the
/// three-state-per-field convention.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ConfigUpdate {
    pub auth_canister: Option<Option<Principal>>,
}

impl Config {
    /// Applies `update` on top of `self`, field by field, per
    /// `ConfigUpdate`'s three-state doc comment.
    pub fn apply(mut self, update: ConfigUpdate) -> Self {
        if let Some(v) = update.auth_canister {
            self.auth_canister = v;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    #[test]
    fn default_update_changes_nothing() {
        let config = Config {
            auth_canister: Some(principal(1)),
        };
        assert_eq!(config.clone().apply(ConfigUpdate::default()), config);
    }

    #[test]
    fn some_none_clears_the_field() {
        let config = Config {
            auth_canister: Some(principal(1)),
        };
        let updated = config.apply(ConfigUpdate {
            auth_canister: Some(None),
        });
        assert_eq!(updated.auth_canister, None);
    }

    #[test]
    fn some_some_sets_the_field() {
        let updated = Config::default().apply(ConfigUpdate {
            auth_canister: Some(Some(principal(2))),
        });
        assert_eq!(updated.auth_canister, Some(principal(2)));
    }
}
