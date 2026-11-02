//! Certified static serving for the built `inventory-browser` (SME admin) and
//! `storefront` (public shop). The admin app is mounted at `/admin/`; the
//! storefront owns `/` and is also aliased at `/shop`.
//!
//! The directory is embedded into the wasm at compile time with
//! [`include_dir`], then registered with [`ic_asset_certification`] during
//! `init` and rebuilt during `post_upgrade`. The router owns the HTTP
//! certification tree, and every query response includes the witness the IC
//! HTTP gateway needs to verify the asset body, status, and headers.

use crate::http::{HeaderField, HttpRequest, HttpResponse};
use ic_asset_certification::{Asset, AssetConfig, AssetFallbackConfig, AssetRouter};
use ic_http_certification::{HttpRequest as CertifiedHttpRequest, Method, StatusCode};
use include_dir::{include_dir, Dir};
use std::{cell::RefCell, collections::HashSet};

static ADMIN_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../inventory-browser/dist");
static STOREFRONT_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../storefront/dist");
const NOT_FOUND_ASSET: &str = "__canister_hub_not_found__.txt";
const IC_DOMAINS_ASSET: &str = ".well-known/ic-domains";

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

/// Converts the textarea value into the custom-domain service's file format:
/// one trimmed, lowercase domain per line, in user-entered order.
fn normalize_ic_domains(input: &str) -> Vec<u8> {
    let mut seen = HashSet::new();
    let mut domains = Vec::new();
    for line in input.lines() {
        let domain = line.trim().to_ascii_lowercase();
        if !domain.is_empty() && seen.insert(domain.clone()) {
            domains.push(domain);
        }
    }

    if domains.is_empty() {
        Vec::new()
    } else {
        format!("{}\n", domains.join("\n")).into_bytes()
    }
}

fn configured_ic_domains() -> Vec<u8> {
    canister_hub_sdk::ic::config::get_env_text("ic_domains")
        .map(|value| normalize_ic_domains(&value))
        .unwrap_or_default()
}

/// Cookie key naming the asset-storage canister selected through this
/// module's dynamic configuration.
const STORAGE_CANISTER_ID_KEY: &str = "storage_canister_id";
const STOREFRONT_BUSINESS_NAME_KEY: &str = "storefront_business_name";
const STOREFRONT_LOGO_URL_KEY: &str = "storefront_logo_url";

/// Builds the standard `ic_env` cookie from the runtime environment. All
/// `PUBLIC_*` values are forwarded, `storage_canister_id` comes from the
/// dynamic config, and the embedded browser's `backend` is always this
/// order_inventory canister itself. The real root key is mandatory:
/// `safeGetCanisterEnv` rejects the complete cookie if that field is absent
/// or malformed, making otherwise valid canister IDs appear missing too.
/// The header is added before certification, so it is covered by the asset
/// response hash rather than appended afterward.
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
    if let Some(storage_id) = canister_hub_sdk::ic::config::get_env_principal("storage_canister") {
        params.push((STORAGE_CANISTER_ID_KEY.to_string(), storage_id.to_text()));
    }
    for (config_key, cookie_key) in [
        ("storefront_business_name", STOREFRONT_BUSINESS_NAME_KEY),
        ("storefront_logo_url", STOREFRONT_LOGO_URL_KEY),
    ] {
        if let Some(value) = canister_hub_sdk::ic::config::get_env_text(config_key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            params.push((cookie_key.to_string(), value));
        }
    }
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

fn add_directory(
    directory: &'static Dir<'static>,
    prefix: &str,
    entry_aliases: &[&str],
    fallback_scope: Option<&str>,
    assets: &mut Vec<Asset<'static, 'static>>,
    configs: &mut Vec<AssetConfig>,
    certified_headers: &[HeaderField],
) {
    for file in directory.files() {
        let source_path = file
            .path()
            .to_str()
            .expect("embedded inventory-browser asset path must be UTF-8")
            .to_string();
        let path = if prefix.is_empty() {
            source_path.clone()
        } else {
            format!("{prefix}/{source_path}")
        };
        let (aliases, fallback_for) = if source_path == "index.html" {
            (
                entry_aliases
                    .iter()
                    .map(|alias| (*alias).to_string())
                    .collect(),
                fallback_scope
                    .map(|scope| {
                        vec![AssetFallbackConfig {
                            scope: scope.to_string(),
                            status_code: Some(StatusCode::OK),
                        }]
                    })
                    .unwrap_or_default(),
            )
        } else {
            (Vec::new(), Vec::new())
        };
        configs.push(AssetConfig::File {
            path: path.clone(),
            content_type: Some(content_type(&source_path).to_string()),
            headers: certified_headers.to_vec(),
            fallback_for,
            aliased_by: aliases,
            encodings: Vec::new(),
        });
        assets.push(Asset::new(path, file.contents()));
    }

    for child in directory.dirs() {
        add_directory(
            child,
            prefix,
            entry_aliases,
            fallback_scope,
            assets,
            configs,
            certified_headers,
        );
    }
}

fn build_router(certified_headers: Vec<HeaderField>, ic_domains: Vec<u8>) -> AssetRouter<'static> {
    let mut assets = Vec::new();
    let mut configs = Vec::new();
    add_directory(
        &ADMIN_DIST,
        "admin",
        &["/admin", "/admin/"],
        Some("/admin"),
        &mut assets,
        &mut configs,
        &certified_headers,
    );
    add_directory(
        &STOREFRONT_DIST,
        "",
        &["/", "/shop"],
        None,
        &mut assets,
        &mut configs,
        &certified_headers,
    );

    // This file is dynamic but still goes through the same certified router.
    // Do not attach the UI's ic_env cookie to the custom-domain proof file.
    assets.push(Asset::new(IC_DOMAINS_ASSET, ic_domains));
    configs.push(AssetConfig::File {
        path: IC_DOMAINS_ASSET.to_string(),
        content_type: Some("text/plain; charset=utf-8".to_string()),
        headers: Vec::new(),
        fallback_for: Vec::new(),
        aliased_by: Vec::new(),
        encodings: Vec::new(),
    });

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
        .expect("order_inventory browser assets must have valid certification configuration");
    router
}

/// Builds the complete asset certification tree and publishes its root hash.
/// This must run during install and upgrade because the router is heap state.
pub fn certify() {
    let router = build_router(vec![ic_env_cookie()], configured_ic_domains());
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

/// Serves an embedded asset with the package-generated `IC-Certificate`
/// witness. Update calls have no data certificate and cannot serve a
/// verifiable asset response.
pub fn serve(request: &HttpRequest) -> HttpResponse {
    let Some(certificate) = ic_cdk::api::data_certificate() else {
        return error_response("certified assets must be requested through http_request query");
    };
    ASSET_ROUTER.with_borrow(|router| serve_from_router(router, request, &certificate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, method: &str) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            url: path.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn test_router() -> AssetRouter<'static> {
        build_router(
            vec![("set-cookie".to_string(), "ic_env=test".to_string())],
            Vec::new(),
        )
    }

    fn a_built_asset(extension: &str) -> String {
        ADMIN_DIST
            .get_dir("assets")
            .expect("inventory-browser must be built before order_inventory")
            .files()
            .find(|file| file.path().extension().is_some_and(|ext| ext == extension))
            .expect("expected a built asset with this extension")
            .path()
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn content_type_covers_the_browser_assets() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/index.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("assets/index.css"), "text/css; charset=utf-8");
    }

    #[test]
    fn root_and_built_assets_are_served_with_certificate_headers() {
        let router = test_router();
        for path in [
            "/admin".to_string(),
            format!("/admin/{}", a_built_asset("js")),
        ] {
            let response = serve_from_router(&router, &request(&path, "GET"), &[1, 2, 3]);
            assert_eq!(response.status_code, 200);
            assert!(!response.body.is_empty());
            assert!(response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
            assert!(response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("IC-CertificateExpression")));
        }
    }

    #[test]
    fn storefront_is_served_at_the_root_and_shop_alias() {
        let router = test_router();
        for path in ["/", "/shop"] {
            let response = serve_from_router(&router, &request(path, "GET"), &[1, 2, 3]);
            assert_eq!(response.status_code, 200);
            assert!(response.body.starts_with(b"<!doctype html>"));
            assert!(response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
        }
    }

    #[test]
    fn unknown_paths_use_the_certified_404_fallback() {
        let router = test_router();
        let response = serve_from_router(
            &router,
            &request("/this-path-does-not-exist.js", "GET"),
            &[1, 2, 3],
        );
        assert_eq!(response.status_code, 404);
        assert_eq!(response.body, b"not found");
        assert!(response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
    }

    #[test]
    fn admin_subroutes_fall_back_to_the_browser_entry_point() {
        let router = test_router();
        let response = serve_from_router(
            &router,
            &request("/admin/tables/example", "GET"),
            &[1, 2, 3],
        );
        assert_eq!(response.status_code, 200);
        assert!(response.body.starts_with(b"<!doctype html>"));
        assert!(String::from_utf8(response.body)
            .unwrap()
            .contains("/admin/assets/"));
    }

    #[test]
    fn root_serves_the_storefront_not_the_admin_ui() {
        let router = test_router();
        let response = serve_from_router(&router, &request("/", "GET"), &[1, 2, 3]);
        assert_eq!(response.status_code, 200);
        let body = String::from_utf8(response.body).unwrap();
        assert!(!body.contains("/admin/assets/"));
    }

    #[test]
    fn percent_encoding_preserves_the_cookie_payload() {
        assert_eq!(
            percent_encode("PUBLIC_CANISTER_ID:backend=abc&ic_root_key=00"),
            "PUBLIC_CANISTER_ID%3Abackend%3Dabc%26ic_root_key%3D00"
        );
    }

    #[test]
    fn domains_are_normalized_and_served_as_a_certified_text_file() {
        let domains = normalize_ic_domains(
            " Shop.Example.com \r\nwww.shop.example.com\nshop.example.com\n\n",
        );
        assert_eq!(domains, b"shop.example.com\nwww.shop.example.com\n");

        let router = build_router(
            vec![("set-cookie".to_string(), "ic_env=test".to_string())],
            domains,
        );
        let response = serve_from_router(
            &router,
            &request("/.well-known/ic-domains", "GET"),
            &[1, 2, 3],
        );
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, b"shop.example.com\nwww.shop.example.com\n");
        assert!(response.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("content-type")
                && value.eq_ignore_ascii_case("text/plain; charset=utf-8")
        }));
        assert!(!response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("set-cookie")));
        assert!(response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("IC-Certificate")));
    }
}
