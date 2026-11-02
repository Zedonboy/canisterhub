//! Certified static serving for `packages/chat-ui`'s built `dist/`.
//! The SME inbox is mounted at `/inbox`; the customer web chat is mounted at
//! `/chat`. Shared Vite assets and PWA files remain at their built root paths.

use crate::http::{HeaderField, HttpRequest, HttpResponse};
use ic_asset_certification::{Asset, AssetConfig, AssetFallbackConfig, AssetRouter};
use ic_http_certification::{HttpRequest as CertifiedHttpRequest, Method, StatusCode};
use include_dir::{include_dir, Dir};
use std::cell::RefCell;

static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../chat-ui/dist");
const NOT_FOUND_ASSET: &str = "__canister_hub_not_found__.txt";

thread_local! {
    static ASSET_ROUTER: RefCell<AssetRouter<'static>> =
        RefCell::new(AssetRouter::default());
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn ic_env_cookie() -> HeaderField {
    const BACKEND_ID_KEY: &str = "PUBLIC_CANISTER_ID:backend";
    let mut params = (0..ic_cdk::api::env_var_count())
        .map(ic_cdk::api::env_var_name)
        .filter(|name| name.starts_with("PUBLIC_") && name != BACKEND_ID_KEY)
        .map(|name| {
            let value = ic_cdk::api::env_var_value(&name);
            (name, value)
        })
        .collect::<Vec<_>>();
    params.push((
        BACKEND_ID_KEY.to_string(),
        ic_cdk::api::canister_self().to_text(),
    ));
    params.sort_unstable_by(|left, right| left.0.cmp(&right.0));

    let root_key_hex = ic_cdk::api::root_key()
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    params.push(("ic_root_key".to_string(), root_key_hex));
    let raw_value = params
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    (
        "set-cookie".to_string(),
        format!(
            "ic_env={}; Path=/; SameSite=Lax",
            percent_encode(&raw_value)
        ),
    )
}

fn build_router(certified_headers: Vec<HeaderField>) -> AssetRouter<'static> {
    let mut assets = Vec::new();
    let mut configs = Vec::new();

    for file in DIST.files() {
        let path = file
            .path()
            .to_str()
            .expect("embedded chat-ui asset path must be UTF-8")
            .to_string();
        let aliases = match path.as_str() {
            "index.html" => vec!["/inbox".to_string()],
            "chat.html" => vec!["/chat".to_string()],
            _ => Vec::new(),
        };
        configs.push(AssetConfig::File {
            path: path.clone(),
            content_type: Some(content_type(&path).to_string()),
            headers: certified_headers.clone(),
            fallback_for: Vec::new(),
            aliased_by: aliases,
            encodings: Vec::new(),
        });
        assets.push(Asset::new(path, file.contents()));
    }
    for directory in DIST.dirs() {
        add_directory(directory, &mut assets, &mut configs, &certified_headers);
    }

    assets.push(Asset::new(NOT_FOUND_ASSET, b"not found".as_slice()));
    configs.push(AssetConfig::File {
        path: NOT_FOUND_ASSET.to_string(),
        content_type: Some("text/plain; charset=utf-8".to_string()),
        headers: certified_headers,
        fallback_for: vec![AssetFallbackConfig {
            scope: "/".to_string(),
            status_code: Some(StatusCode::NOT_FOUND),
        }],
        aliased_by: Vec::new(),
        encodings: Vec::new(),
    });

    let mut router = AssetRouter::default();
    router
        .certify_assets(assets, configs)
        .expect("chat-ui assets must have valid certification configuration");
    router
}

fn add_directory(
    directory: &'static Dir<'static>,
    assets: &mut Vec<Asset<'static, 'static>>,
    configs: &mut Vec<AssetConfig>,
    certified_headers: &[HeaderField],
) {
    for file in directory.files() {
        let path = file
            .path()
            .to_str()
            .expect("embedded chat-ui asset path must be UTF-8")
            .to_string();
        configs.push(AssetConfig::File {
            path: path.clone(),
            content_type: Some(content_type(&path).to_string()),
            headers: certified_headers.to_vec(),
            fallback_for: Vec::new(),
            aliased_by: Vec::new(),
            encodings: Vec::new(),
        });
        assets.push(Asset::new(path, file.contents()));
    }
    for child in directory.dirs() {
        add_directory(child, assets, configs, certified_headers);
    }
}

/// Rebuilds the heap-only asset tree during install and after every upgrade.
pub fn certify() {
    let router = build_router(vec![ic_env_cookie()]);
    ic_cdk::api::certified_data_set(router.root_hash());
    ASSET_ROUTER.with_borrow_mut(|current| *current = router);
}

fn error_response(message: impl Into<String>) -> HttpResponse {
    HttpResponse {
        status_code: 500,
        headers: vec![(
            "content-type".to_string(),
            "text/plain; charset=utf-8".to_string(),
        )],
        body: message.into().into_bytes(),
        upgrade: None,
    }
}

fn serve_from_router(
    router: &AssetRouter<'static>,
    request: &HttpRequest,
    certificate: &[u8],
) -> HttpResponse {
    let method = match request.method.parse::<Method>() {
        Ok(method) => method,
        Err(_) => return error_response("invalid HTTP method"),
    };
    let certified_request = CertifiedHttpRequest::builder()
        .with_method(method)
        .with_url(request.url.clone())
        .with_headers(request.headers.clone())
        .with_body(request.body.clone())
        .with_certificate_version(2)
        .build();

    match router.serve_asset(certificate, &certified_request) {
        Ok(response) => HttpResponse {
            status_code: response.status_code().as_u16(),
            headers: response.headers().to_vec(),
            body: response.body().to_vec(),
            upgrade: response.upgrade(),
        },
        Err(error) => error_response(format!("failed to serve certified asset: {error}")),
    }
}

pub fn serve(request: &HttpRequest) -> HttpResponse {
    let Some(certificate) = ic_cdk::api::data_certificate() else {
        return error_response("certified assets must be requested through http_request query");
    };
    ASSET_ROUTER.with_borrow(|router| serve_from_router(router, request, &certificate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> HttpRequest {
        HttpRequest {
            method: "GET".to_string(),
            url: path.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    #[test]
    fn inbox_chat_and_pwa_files_are_certified() {
        let router = build_router(vec![("set-cookie".to_string(), "ic_env=test".to_string())]);
        for path in ["/inbox", "/chat", "/manifest.webmanifest", "/sw.js"] {
            let response = serve_from_router(&router, &request(path), &[1, 2, 3]);
            assert_eq!(response.status_code, 200, "{path}");
            assert!(!response.body.is_empty(), "{path}");
            assert!(response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
        }
    }

    #[test]
    fn unknown_paths_use_the_certified_404() {
        let router = build_router(Vec::new());
        let response = serve_from_router(&router, &request("/missing"), &[1, 2, 3]);
        assert_eq!(response.status_code, 404);
        assert_eq!(response.body, b"not found");
        assert!(response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
    }

    #[test]
    fn content_types_cover_the_pwa_assets() {
        assert_eq!(content_type("chat.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("manifest.webmanifest"),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(content_type("sw.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("icon.png"), "image/png");
    }
}
