//! Authorization, configuration secrecy, and initial metering tests for the
//! managed AI gateway. Live provider calls are deliberately not made in CI.

use backend::{
    CanisterInfo, CanisterKind, ManagedAiChoice, ManagedAiCompletionRequest,
    ManagedAiCompletionResponse, ManagedAiConfigUpdate, ManagedAiMessage, ManagedAiRequest,
    ManagedAiResponse, ManagedAiRole, ManagedAiService, ManagedAiStatus, ManagedAiUsage,
    TokenCreditBalance,
};
use candid::Principal;
use pocket_ic::common::rest::{CanisterHttpReply, CanisterHttpResponse, MockCanisterHttpResponse};
use pocket_ic::{query_candid_as, update_candid_as, PocketIc, PocketIcBuilder};

const WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

fn principal(byte: u8) -> Principal {
    Principal::from_slice(&[byte; 10])
}

fn controller() -> Principal {
    principal(1)
}

fn owner() -> Principal {
    principal(2)
}

fn outsider() -> Principal {
    principal(3)
}

fn setup() -> (PocketIc, Principal, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let id = pic.create_canister_with_settings(Some(controller()), None);
    let agent = pic.create_canister_with_settings(Some(owner()), None);
    pic.add_cycles(id, 30_000_000_000_000);
    pic.install_canister(
        id,
        WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller()),
    );
    (pic, id, agent)
}

fn create_project(pic: &PocketIc, id: Principal, agent: Principal) {
    let (created,): (Result<(), String>,) = update_candid_as(
        pic,
        id,
        owner(),
        "create_project",
        (
            "project-1".to_string(),
            "managed AI test".to_string(),
            "local".to_string(),
        ),
    )
    .unwrap();
    created.unwrap();

    let (added,): (Result<(), String>,) = update_candid_as(
        pic,
        id,
        owner(),
        "add_project_canisters",
        (
            "project-1".to_string(),
            vec![(
                "agent".to_string(),
                CanisterInfo {
                    id: agent,
                    kind: CanisterKind::Agent,
                },
            )],
        ),
    )
    .unwrap();
    added.unwrap();
}

fn grant_credits(pic: &PocketIc, id: Principal, amount: u64) -> TokenCreditBalance {
    let (result,): (Result<TokenCreditBalance, String>,) = update_candid_as(
        pic,
        id,
        controller(),
        "grant_token_credits",
        (owner(), amount),
    )
    .unwrap();
    result.unwrap()
}

fn request(project_id: &str) -> ManagedAiRequest {
    ManagedAiRequest {
        project_id: project_id.to_string(),
        system_prompt: Some("Be concise".to_string()),
        messages: vec![ManagedAiMessage {
            role: ManagedAiRole::User,
            content: "hello".to_string(),
        }],
        max_output_tokens: Some(64),
        temperature: Some(0.0),
    }
}

#[test]
fn managed_ai_configuration_is_controller_only_and_secret_is_write_only() {
    let (pic, id, _) = setup();
    let update = ManagedAiConfigUpdate {
        enabled: true,
        provider: "openai".to_string(),
        model: "gpt-test".to_string(),
        api_key: Some("not-a-real-key".to_string()),
        clear_api_key: false,
    };

    let (rejected,): (Result<ManagedAiStatus, String>,) =
        update_candid_as(&pic, id, owner(), "configure_managed_ai", (update.clone(),)).unwrap();
    assert!(rejected.unwrap_err().contains("controller"));

    let (configured,): (Result<ManagedAiStatus, String>,) =
        update_candid_as(&pic, id, controller(), "configure_managed_ai", (update,)).unwrap();
    let configured = configured.unwrap();
    assert!(configured.enabled);
    assert!(configured.api_key_configured);
    assert_eq!(configured.provider, "openai");

    let (public_status,): (ManagedAiStatus,) =
        query_candid_as(&pic, id, outsider(), "get_managed_ai_status", ()).unwrap();
    assert_eq!(public_status, configured);
}

#[test]
fn managed_deepseek_completion_charges_the_controller_account_without_a_project() {
    let (pic, id, agent) = setup();
    grant_credits(&pic, id, 10_000);
    let update = ManagedAiConfigUpdate {
        enabled: true,
        provider: "deepseek".to_string(),
        model: "deepseek-chat".to_string(),
        api_key: Some("not-a-real-key".to_string()),
        clear_api_key: false,
    };
    let (configured,): (Result<ManagedAiStatus, String>,) =
        update_candid_as(&pic, id, controller(), "configure_managed_ai", (update,)).unwrap();
    configured.unwrap();

    let request = ManagedAiCompletionRequest {
        service: ManagedAiService::DeepSeek,
        model: None,
        messages_json: serde_json::to_string(&vec![ic_rig::Message::user("hello")]).unwrap(),
        tools_json: "[]".to_string(),
        max_output_tokens: Some(64),
        temperature: Some(0.0),
    };
    let call_id = pic
        .submit_call(
            id,
            agent,
            "managed_ai_completion",
            candid::encode_args((request,)).unwrap(),
        )
        .unwrap();
    let mut requests = Vec::new();
    for _ in 0..10 {
        pic.tick();
        requests = pic.get_canister_http();
        if !requests.is_empty() {
            break;
        }
    }
    assert_eq!(requests.len(), 1);
    assert!(requests[0].url.contains("api.deepseek.com"));
    let body = serde_json::json!({
        "choices": [{
            "message": { "role": "assistant", "content": "managed reply" },
            "finish_reason": "stop",
            "index": 0
        }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
    })
    .to_string();
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: requests[0].subnet_id,
        request_id: requests[0].request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 200,
            headers: vec![],
            body: body.into_bytes(),
        }),
        additional_responses: vec![],
    });
    let reply = pic.await_call(call_id).unwrap();
    let (result,): (Result<ManagedAiCompletionResponse, String>,) =
        candid::decode_args(&reply).unwrap();
    let response = result.unwrap();
    assert_eq!(
        response.choice,
        ManagedAiChoice::Message("managed reply".to_string())
    );
    assert_eq!(response.usage.total_tokens, 5);
    assert!(response.remaining_token_credits < 10_000);
}

#[test]
fn token_credits_are_controller_granted_and_owner_readable() {
    let (pic, id, _) = setup();
    let account = grant_credits(&pic, id, 5_000);
    assert_eq!(account.balance, 5_000);
    assert_eq!(account.reserved, 0);
    assert_eq!(account.available, 5_000);

    let (visible,): (Result<Option<TokenCreditBalance>, String>,) =
        query_candid_as(&pic, id, owner(), "get_token_credits", (owner(),)).unwrap();
    assert_eq!(visible.unwrap(), Some(account));

    let (hidden,): (Result<Option<TokenCreditBalance>, String>,) =
        query_candid_as(&pic, id, outsider(), "get_token_credits", (owner(),)).unwrap();
    assert!(hidden
        .unwrap_err()
        .contains("account owner or a controller"));

    let (rejected,): (Result<TokenCreditBalance, String>,) =
        update_candid_as(&pic, id, owner(), "grant_token_credits", (owner(), 1u64)).unwrap();
    assert!(rejected.unwrap_err().contains("controller"));
}

#[test]
fn managed_ai_rejects_unregistered_callers_before_an_outcall() {
    let (pic, id, _) = setup();
    create_project(&pic, id, principal(4));

    let (result,): (Result<ManagedAiResponse, String>,) = update_candid_as(
        &pic,
        id,
        outsider(),
        "managed_ai_complete",
        (request("project-1"),),
    )
    .unwrap();
    assert!(result.unwrap_err().contains("only be called by a canister"));
}

#[test]
fn calling_canister_must_be_controlled_by_the_system_account_owner() {
    let (pic, id, _) = setup();
    let foreign_canister = pic.create_canister_with_settings(Some(outsider()), None);
    create_project(&pic, id, foreign_canister);
    grant_credits(&pic, id, 10_000);

    let (result,): (Result<ManagedAiResponse, String>,) = update_candid_as(
        &pic,
        id,
        foreign_canister,
        "managed_ai_complete",
        (request("project-1"),),
    )
    .unwrap();
    assert!(result
        .unwrap_err()
        .contains("project owner is not a controller"));
}

#[test]
fn project_owner_can_read_an_empty_usage_breakdown() {
    let (pic, id, agent) = setup();
    create_project(&pic, id, agent);

    let (rows,): (Result<Vec<ManagedAiUsage>, String>,) = query_candid_as(
        &pic,
        id,
        owner(),
        "get_managed_ai_usage",
        ("project-1".to_string(),),
    )
    .unwrap();
    assert!(rows.unwrap().is_empty());

    let (rejected,): (Result<Vec<ManagedAiUsage>, String>,) = query_candid_as(
        &pic,
        id,
        outsider(),
        "get_managed_ai_usage",
        ("project-1".to_string(),),
    )
    .unwrap();
    assert!(rejected.unwrap_err().contains("project owner"));
}

#[test]
fn a_registered_project_canister_reaches_the_gateway_and_config_survives_upgrade() {
    let (pic, id, agent) = setup();
    create_project(&pic, id, agent);
    grant_credits(&pic, id, 10_000);

    // Default configuration is disabled. Reaching this error proves the
    // registered canister passed project authorization without making a live
    // provider request in the test suite.
    let (result,): (Result<ManagedAiResponse, String>,) = update_candid_as(
        &pic,
        id,
        agent,
        "managed_ai_complete",
        (request("project-1"),),
    )
    .unwrap();
    assert_eq!(result.unwrap_err(), "managed AI is disabled");

    let update = ManagedAiConfigUpdate {
        enabled: true,
        provider: "anthropic".to_string(),
        model: "claude-test".to_string(),
        api_key: Some("upgrade-test-key".to_string()),
        clear_api_key: false,
    };
    let (configured,): (Result<ManagedAiStatus, String>,) =
        update_candid_as(&pic, id, controller(), "configure_managed_ai", (update,)).unwrap();
    let configured = configured.unwrap();

    pic.upgrade_canister(
        id,
        WASM.to_vec(),
        candid::encode_one(()).unwrap(),
        Some(controller()),
    )
    .unwrap();

    let (after_upgrade,): (ManagedAiStatus,) =
        query_candid_as(&pic, id, owner(), "get_managed_ai_status", ()).unwrap();
    assert_eq!(after_upgrade, configured);
}

#[test]
fn token_balance_covers_input_and_maximum_output_before_provider_call() {
    let (pic, id, agent) = setup();
    create_project(&pic, id, agent);
    grant_credits(&pic, id, 10);

    let update = ManagedAiConfigUpdate {
        enabled: true,
        provider: "openai".to_string(),
        model: "gpt-test".to_string(),
        api_key: Some("not-a-real-key".to_string()),
        clear_api_key: false,
    };
    let (configured,): (Result<ManagedAiStatus, String>,) =
        update_candid_as(&pic, id, controller(), "configure_managed_ai", (update,)).unwrap();
    configured.unwrap();

    let (result,): (Result<ManagedAiResponse, String>,) = update_candid_as(
        &pic,
        id,
        agent,
        "managed_ai_complete",
        (request("project-1"),),
    )
    .unwrap();
    let error = result.unwrap_err();
    assert!(error.contains("insufficient token credits"), "{error}");

    let (account,): (Result<Option<TokenCreditBalance>, String>,) =
        query_candid_as(&pic, id, owner(), "get_token_credits", (owner(),)).unwrap();
    let account = account.unwrap().unwrap();
    assert_eq!(account.balance, 10);
    assert_eq!(account.reserved, 0);
    assert_eq!(account.available, 10);
}
