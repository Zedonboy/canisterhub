use crate::http::auth::ApiKeyAuthenticated;
use crate::outbound::relay::{self, SendMailRequest};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/send_mail", post(send_mail))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

#[derive(Deserialize)]
struct SendMailBody {
    from: String,
    to: Vec<String>,
    subject: String,
    #[serde(default)]
    text_body: Option<String>,
    #[serde(default)]
    html_body: Option<String>,
}

/// A canister calls this via an HTTPS outcall (`Authorization: Bearer
/// <MAIL_BRIDGE_API_KEY>`) to have this bridge relay an email out through the
/// configured upstream SMTP server - see README.md's "Outbound: sending mail
/// from a canister" section.
async fn send_mail(
    State(state): State<AppState>,
    _auth: ApiKeyAuthenticated,
    Json(body): Json<SendMailBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let request = SendMailRequest {
        from: body.from,
        to: body.to,
        subject: body.subject,
        text_body: body.text_body,
        html_body: body.html_body,
    };

    relay::send_mail(&state.config, &request)
        .await
        .map(|()| Json(json!({ "success": true })))
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({ "success": false, "error": e.to_string() }))))
}
