//! Project-scoped Web Push gateway.
//!
//! Project packages call this backend with their project id. The backend
//! authorizes the calling canister against the project's tracked canister
//! registry, resolves the project's single notification canister, and asks it
//! to deliver the payload only to the project's owner.

use candid::Principal;
use ic_cdk::call::Call;

use crate::{
    is_notification_canister, PushDelivery, PushNotification, MAX_PROJECT_ID_BYTES, PROJECTS,
};

const MAX_NOTIFICATION_TITLE_BYTES: usize = 200;
const MAX_NOTIFICATION_BODY_BYTES: usize = 4 * 1_024;
const MAX_NOTIFICATION_URL_BYTES: usize = 2_048;

fn ensure_text_size(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        Err(format!(
            "{label} is too large ({} bytes; maximum {max})",
            value.len()
        ))
    } else {
        Ok(())
    }
}

fn resolve_route(project_id: &str, caller: Principal) -> Result<(Principal, Principal), String> {
    if project_id.is_empty() || project_id.len() > MAX_PROJECT_ID_BYTES {
        return Err(format!(
            "project_id must contain between 1 and {MAX_PROJECT_ID_BYTES} bytes"
        ));
    }
    if caller == Principal::anonymous() {
        return Err("anonymous callers may not send project notifications".to_string());
    }

    let project = PROJECTS
        .with(|projects| projects.borrow().get(&project_id.to_string()))
        .ok_or_else(|| "project not found".to_string())?;

    if !project
        .canisters
        .values()
        .any(|canister| canister.id == caller)
    {
        return Err("caller is not a canister registered in this project".to_string());
    }

    let notification_id = project
        .canisters
        .iter()
        .find(|(name, canister)| is_notification_canister(name, canister))
        .map(|(_, canister)| canister.id)
        .ok_or_else(|| "project has no notification canister".to_string())?;

    Ok((project.owner, notification_id))
}

/// Accepts a notification only from a canister tracked in `project_id`, then
/// routes it through that project's notification canister to the project
/// owner. The notification canister must list this backend as a trusted
/// sender; the dashboard configures that automatically for new deployments.
#[ic_cdk::update]
pub async fn send_project_notification(
    project_id: String,
    notification: PushNotification,
) -> Result<Vec<PushDelivery>, String> {
    ensure_text_size(
        "notification title",
        &notification.title,
        MAX_NOTIFICATION_TITLE_BYTES,
    )?;
    ensure_text_size(
        "notification body",
        &notification.body,
        MAX_NOTIFICATION_BODY_BYTES,
    )?;
    ensure_text_size(
        "notification URL",
        &notification.url,
        MAX_NOTIFICATION_URL_BYTES,
    )?;

    let caller = ic_cdk::api::msg_caller();
    let (owner, notification_id) = resolve_route(&project_id, caller)?;
    let response = Call::bounded_wait(notification_id, "push_send")
        .with_args(&(owner, notification))
        .await
        .map_err(|error| format!("notification canister call failed: {error:?}"))?;

    response
        .candid::<Result<Vec<PushDelivery>, String>>()
        .map_err(|error| format!("notification canister returned an invalid response: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_notification_fields() {
        assert!(ensure_text_size("title", &"x".repeat(201), 200).is_err());
        assert!(ensure_text_size("title", &"x".repeat(200), 200).is_ok());
    }
}
