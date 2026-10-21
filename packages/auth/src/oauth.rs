//! The OAuth 2.0 Authorization Code flow, from building the authorize URL
//! through exchanging the callback's `code` for a token and fetching the
//! user's profile. Generic across providers (Google, GitHub, or any other
//! OAuth2-compliant service) - see `config::OAuthProviderConfig` for
//! exactly what varies per provider, and `lib.rs`'s module doc comment for
//! how this fits into the rest of the canister.
//!
//! ## Why no PKCE
//!
//! PKCE (RFC 7636) exists to protect *public* clients (a browser SPA or a
//! mobile app, neither of which can keep a `client_secret` confidential)
//! from a stolen authorization code being redeemed by an attacker. This
//! canister holds `client_secret` itself (`OAuthProviderConfig::client_secret`)
//! and performs the token exchange itself, canister-side - exactly the
//! "confidential client" case PKCE exists to make unnecessary. Every
//! provider that accepts PKCE also accepts the classic flow for a
//! confidential client; a deployment that specifically needs PKCE anyway
//! (some providers now require it regardless of client type) would need to
//! extend this module.

use crate::config::OAuthProviderConfig;
use ic_cdk::management_canister::{http_request, HttpHeader, HttpMethod, HttpRequestArgs};
use serde::Deserialize;

/// The URL to redirect the user's browser to, to start `config`'s consent
/// screen - `state` is this canister's own CSRF token (see
/// `state::PendingOAuthState`), round-tripped back on the callback and
/// checked there (`lib.rs::handle_oauth_callback`).
pub fn authorize_url(config: &OAuthProviderConfig, state: &str) -> String {
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}",
        config.authorize_url,
        urlencode(&config.client_id),
        urlencode(&config.redirect_uri),
        urlencode(&config.scope),
        urlencode(state),
    )
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// What this module hands back to `lib.rs` once a `code` has actually been
/// redeemed for a real identity - never constructed except by
/// `exchange_code`.
pub struct UserInfo {
    /// The provider's own stable user id (OIDC's "sub" claim, or whatever
    /// the equivalent field is called for a non-OIDC provider - see
    /// `find_subject`). Never the email: providers let users change that.
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// Exchanges an authorization `code` for an access token, then immediately
/// uses it to fetch the user's profile from `config.userinfo_url`. Two
/// outcalls, not one - the token and userinfo endpoints are separate by
/// design in OAuth2 (a token is useful for more than just identifying the
/// user), not something this module could collapse into one call.
///
/// Both outcalls are single-replica (`is_replicated: Some(false)`): an
/// authorization `code` is single-use, so if every replica attempted this
/// exchange independently (the default), only the first would succeed and
/// the rest would see a real error from the provider - the same reasoning
/// as `connector::outbound`'s message sends.
pub async fn exchange_code(config: &OAuthProviderConfig, code: &str) -> Result<UserInfo, String> {
    let form_body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&client_secret={}",
        urlencode(code),
        urlencode(&config.redirect_uri),
        urlencode(&config.client_id),
        urlencode(&config.client_secret),
    );
    let token_bytes = post_form(&config.token_url, &form_body).await?;
    let token: TokenResponse = serde_json::from_slice(&token_bytes)
        .map_err(|e| format!("could not parse token response: {e}"))?;

    let userinfo_bytes = get_bearer(&config.userinfo_url, &token.access_token).await?;
    let raw: serde_json::Value = serde_json::from_slice(&userinfo_bytes)
        .map_err(|e| format!("could not parse userinfo response: {e}"))?;
    let subject =
        find_subject(&raw).ok_or("userinfo response has no recognizable subject/id field")?;
    Ok(UserInfo {
        subject,
        email: raw
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        name: raw.get("name").and_then(|v| v.as_str()).map(str::to_string),
        picture: raw
            .get("picture")
            .or_else(|| raw.get("avatar_url"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Different providers name the stable user-id field differently:
/// OIDC-compliant ones use `sub`; GitHub uses a numeric `id`; a handful of
/// others use `user_id`. Checked in that order, against a real (if short)
/// list rather than assuming one shape - not exhaustive of every OAuth2
/// provider that exists, but covers the common real cases.
fn find_subject(raw: &serde_json::Value) -> Option<String> {
    for key in ["sub", "id", "user_id"] {
        // `continue`, not `?` - `raw` not having *this* key (or having it
        // in a shape we don't recognize) must fall through to the next
        // candidate key, not abandon the search outright.
        let Some(value) = raw.get(key) else { continue };
        if let Some(s) = value.as_str() {
            return Some(s.to_string());
        }
        if let Some(n) = value.as_u64() {
            return Some(n.to_string());
        }
    }
    None
}

async fn post_form(url: &str, body: &str) -> Result<Vec<u8>, String> {
    let request = HttpRequestArgs {
        url: url.to_string(),
        method: HttpMethod::POST,
        headers: vec![
            HttpHeader {
                name: "Content-Type".to_string(),
                value: "application/x-www-form-urlencoded".to_string(),
            },
            HttpHeader {
                name: "Accept".to_string(),
                value: "application/json".to_string(),
            },
        ],
        body: Some(body.as_bytes().to_vec()),
        // A token response is a small JSON object, not a payload of
        // meaningful size - plenty of headroom without paying to reserve
        // the 2MB default.
        max_response_bytes: Some(8_192),
        transform: None,
        is_replicated: Some(false),
    };
    let response = http_request(&request)
        .await
        .map_err(|e| format!("token exchange outcall to {url} failed: {e:?}"))?;
    if response.status != 200u32 {
        return Err(format!(
            "{url} returned status {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }
    Ok(response.body)
}

async fn get_bearer(url: &str, access_token: &str) -> Result<Vec<u8>, String> {
    let request = HttpRequestArgs {
        url: url.to_string(),
        method: HttpMethod::GET,
        headers: vec![
            HttpHeader {
                name: "Authorization".to_string(),
                value: format!("Bearer {access_token}"),
            },
            HttpHeader {
                name: "Accept".to_string(),
                value: "application/json".to_string(),
            },
        ],
        body: None,
        max_response_bytes: Some(8_192),
        transform: None,
        is_replicated: Some(false),
    };
    let response = http_request(&request)
        .await
        .map_err(|e| format!("userinfo outcall to {url} failed: {e:?}"))?;
    if response.status != 200u32 {
        return Err(format!(
            "{url} returned status {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }
    Ok(response.body)
}

/// Minimal percent-encoding - just enough for the values this module
/// actually sends (URLs, opaque tokens, short scope strings): unreserved
/// characters (RFC 3986) pass through, every other byte becomes `%XX`.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OAuthProviderConfig {
        OAuthProviderConfig {
            client_id: "abc".to_string(),
            client_secret: "shh".to_string(),
            authorize_url: "https://provider.example/authorize".to_string(),
            token_url: "https://provider.example/token".to_string(),
            userinfo_url: "https://provider.example/userinfo".to_string(),
            redirect_uri: "https://canister.icp0.io/oauth/example/callback".to_string(),
            scope: "openid email".to_string(),
        }
    }

    #[test]
    fn urlencode_leaves_unreserved_characters_alone_and_escapes_the_rest() {
        assert_eq!(urlencode("hello-world_1.2~3"), "hello-world_1.2~3");
        assert_eq!(urlencode("a b+c"), "a%20b%2Bc");
        assert_eq!(
            urlencode("https://x.com/cb?a=1"),
            "https%3A%2F%2Fx.com%2Fcb%3Fa%3D1"
        );
    }

    #[test]
    fn authorize_url_embeds_every_real_parameter() {
        let url = authorize_url(&provider(), "state123");
        assert!(url.starts_with("https://provider.example/authorize?"));
        assert!(url.contains("client_id=abc"));
        assert!(url.contains("state=state123"));
        assert!(url.contains("scope=openid%20email"));
        assert!(url
            .contains("redirect_uri=https%3A%2F%2Fcanister.icp0.io%2Foauth%2Fexample%2Fcallback"));
        // client_secret must never appear in the (browser-visible) authorize URL.
        assert!(!url.contains("shh"));
    }

    #[test]
    fn find_subject_checks_sub_then_id_then_user_id_in_order() {
        assert_eq!(
            find_subject(&serde_json::json!({"sub": "u1", "id": "ignored"})),
            Some("u1".to_string())
        );
        assert_eq!(
            find_subject(&serde_json::json!({"id": 42})),
            Some("42".to_string())
        );
        assert_eq!(
            find_subject(&serde_json::json!({"user_id": "u3"})),
            Some("u3".to_string())
        );
        assert_eq!(find_subject(&serde_json::json!({"nothing": "here"})), None);
    }
}
