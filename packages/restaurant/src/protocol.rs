use candid::{CandidType, Deserialize, Principal};

#[derive(CandidType, Deserialize)]
struct PushNotification {
    title: String,
    body: String,
    url: String,
}

pub async fn verify_project_package_membership(
    protocol: Principal,
    project_id: &str,
    package_id: Principal,
) -> Result<bool, String> {
    let response = ic_cdk::call::Call::bounded_wait(protocol, "verify_project_package_membership")
        .with_args(&(project_id.to_string(), package_id))
        .await
        .map_err(|error| format!("protocol membership verification failed: {error:?}"))?;
    let result: Result<bool, String> = response
        .candid()
        .map_err(|error| format!("invalid protocol membership response: {error}"))?;
    result
}

pub fn notify_owner(project_id: String, protocol: Principal, order_id: u64) {
    ic_cdk::futures::spawn(async move {
        let notification = PushNotification {
            title: "New restaurant order".to_string(),
            body: format!("Restaurant order #{order_id} has been placed"),
            url: "/admin/".to_string(),
        };
        match ic_cdk::call::Call::bounded_wait(protocol, "send_project_notification")
            .with_args(&(project_id, notification))
            .await
        {
            Ok(response) => match response.candid::<Result<Vec<Delivery>, String>>() {
                Ok(Ok(_)) => ic_cdk::api::debug_print(format!(
                    "restaurant: owner notified order_id={order_id}"
                )),
                Ok(Err(error)) => ic_cdk::api::debug_print(format!(
                    "restaurant: owner notification rejected order_id={order_id} error={error}"
                )),
                Err(error) => ic_cdk::api::debug_print(format!(
                    "restaurant: notification response decode failed error={error}"
                )),
            },
            Err(error) => ic_cdk::api::debug_print(format!(
                "restaurant: notification call failed order_id={order_id} error={error:?}"
            )),
        }
    });
}

#[derive(CandidType, Deserialize)]
struct Delivery {
    endpoint: String,
    status: Option<u16>,
    error: Option<String>,
    subscription_removed: bool,
}
