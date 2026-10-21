use crate::{auth, create_for, delete_for, list_for, ApiError, CreateItem};
use candid::CandidType;
use serde::{Deserialize, Serialize};

pub type HeaderField = (String, String);

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<HeaderField>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a ApiError,
}

impl HttpResponse {
    fn json(status_code: u16, value: &impl Serialize) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status_code,
                headers: cors_headers("application/json; charset=utf-8"),
                body,
                upgrade: None,
            },
            Err(error) => Self::text(500, format!("failed to encode response: {error}")),
        }
    }

    fn error(status_code: u16, error: &ApiError) -> Self {
        Self::json(status_code, &ErrorBody { error })
    }

    fn text(status_code: u16, body: impl Into<String>) -> Self {
        Self {
            status_code,
            headers: cors_headers("text/plain; charset=utf-8"),
            body: body.into().into_bytes(),
            upgrade: None,
        }
    }

    fn upgrade() -> Self {
        Self {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        }
    }
}

fn cors_headers(content_type: &str) -> Vec<HeaderField> {
    vec![
        ("content-type".to_string(), content_type.to_string()),
        ("access-control-allow-origin".to_string(), "*".to_string()),
        (
            "access-control-allow-methods".to_string(),
            "GET, POST, DELETE, OPTIONS".to_string(),
        ),
        (
            "access-control-allow-headers".to_string(),
            "authorization, content-type".to_string(),
        ),
    ]
}

fn path(url: &str) -> &str {
    url.split_once('?').map_or(url, |(path, _)| path)
}

fn is_api_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/me") | ("GET", "/api/items") | ("POST", "/api/items")
    ) || (method == "DELETE" && path.starts_with("/api/items/"))
}

pub fn query(request: HttpRequest) -> HttpResponse {
    let method = request.method.to_ascii_uppercase();
    let path = path(&request.url);
    if method == "OPTIONS" {
        return HttpResponse {
            status_code: 204,
            headers: cors_headers("text/plain; charset=utf-8"),
            body: vec![],
            upgrade: None,
        };
    }
    if method == "GET" && path == "/health" {
        return HttpResponse::json(200, &crate::health());
    }
    if is_api_route(&method, path) {
        return HttpResponse::upgrade();
    }
    HttpResponse::error(404, &ApiError::NotFound)
}

pub async fn update(request: HttpRequest) -> HttpResponse {
    let method = request.method.to_ascii_uppercase();
    let path = path(&request.url);
    if !is_api_route(&method, path) {
        return HttpResponse::error(404, &ApiError::NotFound);
    }
    if request.body.len() > crate::MAX_HTTP_BODY_BYTES {
        return HttpResponse::error(
            413,
            &ApiError::InvalidInput("request body is too large".to_string()),
        );
    }

    let token = match bearer_token(&request.headers) {
        Ok(token) => token,
        Err(error) => return HttpResponse::error(401, &error),
    };
    let authorization = match auth::session(token).await {
        Ok(authorization) => authorization,
        Err(error) => return HttpResponse::error(error.status_code(), &error),
    };

    match (method.as_str(), path) {
        ("GET", "/api/me") => HttpResponse::json(200, &authorization),
        ("GET", "/api/items") => HttpResponse::json(200, &list_for(authorization.profile_id)),
        ("POST", "/api/items") => {
            let input: CreateItem = match serde_json::from_slice(&request.body) {
                Ok(input) => input,
                Err(error) => {
                    return HttpResponse::error(
                        400,
                        &ApiError::InvalidInput(format!("invalid JSON body: {error}")),
                    )
                }
            };
            match create_for(authorization.profile_id, input) {
                Ok(item) => HttpResponse::json(201, &item),
                Err(error) => HttpResponse::error(error.status_code(), &error),
            }
        }
        ("DELETE", path) => {
            let id = match path
                .strip_prefix("/api/items/")
                .and_then(|value| value.parse::<u64>().ok())
            {
                Some(id) => id,
                None => {
                    return HttpResponse::error(
                        400,
                        &ApiError::InvalidInput("item id must be a nat64".to_string()),
                    )
                }
            };
            match delete_for(authorization.profile_id, id) {
                Ok(item) => HttpResponse::json(200, &item),
                Err(error) => HttpResponse::error(error.status_code(), &error),
            }
        }
        _ => HttpResponse::error(404, &ApiError::NotFound),
    }
}

fn bearer_token(headers: &[HeaderField]) -> Result<&str, ApiError> {
    let value = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.as_str())
        .ok_or_else(|| ApiError::Unauthorized("missing Authorization header".to_string()))?;
    let (scheme, token) = value.split_once(' ').ok_or_else(|| {
        ApiError::Unauthorized("Authorization must be 'Bearer <session-token>'".to_string())
    })?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(' ') {
        Ok(token)
    } else {
        Err(ApiError::Unauthorized(
            "Authorization must be 'Bearer <session-token>'".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_header_is_case_insensitive() {
        let headers = vec![("AUTHORIZATION".to_string(), "bearer abc".to_string())];
        assert_eq!(bearer_token(&headers), Ok("abc"));
    }

    #[test]
    fn only_known_routes_upgrade() {
        let request = |url: &str| HttpRequest {
            method: "GET".to_string(),
            url: url.to_string(),
            headers: vec![],
            body: vec![],
        };
        assert_eq!(query(request("/api/items")).upgrade, Some(true));
        assert_eq!(query(request("/unknown")).status_code, 404);
    }
}
