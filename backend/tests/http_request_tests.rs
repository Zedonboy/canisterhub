//! PocketIC integration tests for `http_request` - the certified-asset
//! serving endpoint backing the embedded CanisterHub landing page (see
//! `backend/src/lib.rs`'s "Landing page assets" section). Exercises the real
//! thing: a built canister Wasm with `landing/dist` actually embedded via
//! `include_dir!`, served through the real IC http gateway interface and
//! verified via a real `IC-Certificate` response header, not a stub.
//!
//! Requires `landing/dist` to exist before `backend.wasm` is built (run
//! `npm install && npm run build` in `landing/` first - see that folder's
//! README) - same build-order precondition `marketplace_tests.rs`'s own
//! header comment documents for the wasm target itself.

use candid::Principal;
use ic_http_certification::{HttpRequest, HttpResponse, StatusCode};
use pocket_ic::{query_candid_as, PocketIc, PocketIcBuilder};

const BACKEND_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/wasm32-unknown-unknown/release/backend.wasm"
));

fn setup() -> (PocketIc, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let admin = Principal::from_slice(&[1; 10]);
    let backend_id = pic.create_canister_with_settings(Some(admin), None);
    pic.add_cycles(backend_id, 30_000_000_000_000);
    pic.install_canister(backend_id, BACKEND_WASM.to_vec(), candid::encode_one(()).unwrap(), Some(admin));
    (pic, backend_id)
}

fn get(pic: &PocketIc, backend_id: Principal, path: &str) -> HttpResponse<'static> {
    let request = HttpRequest::get(path).build();
    let (response,): (HttpResponse,) =
        query_candid_as(pic, backend_id, Principal::anonymous(), "http_request", (request,)).unwrap();
    response
}

fn header<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
    response
        .headers()
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[test]
fn serves_the_landing_page_index_at_root() {
    let (pic, backend_id) = setup();
    let response = get(&pic, backend_id, "/");

    assert_eq!(response.status_code(), StatusCode::OK);
    assert_eq!(header(&response, "content-type"), Some("text/html"));
    let body = String::from_utf8(response.body().to_vec()).unwrap();
    assert!(body.contains("CanisterHub"), "expected the landing page's own title in the body, got: {body}");

    // The whole point of asset *certification*, not just serving: the
    // response must carry a real `IC-Certificate` header the gateway/browser
    // can verify independently against this canister's certified data.
    assert!(header(&response, "ic-certificate").is_some(), "response is missing its certification header");
}

#[test]
fn falls_back_to_the_index_for_an_unknown_path() {
    let (pic, backend_id) = setup();
    let response = get(&pic, backend_id, "/this-path-does-not-exist");

    // Configured as the SPA fallback for the `/` scope (see
    // `init_landing_assets`'s `AssetConfig::File` entry) - any path that
    // doesn't match a real embedded file still resolves to index.html with
    // 200, not a 404, the same way a client-side-routed app needs.
    assert_eq!(response.status_code(), StatusCode::OK);
    let body = String::from_utf8(response.body().to_vec()).unwrap();
    assert!(body.contains("CanisterHub"));
}

#[test]
fn serves_a_hashed_js_asset_with_an_immutable_cache_header() {
    let (pic, backend_id) = setup();
    let index = get(&pic, backend_id, "/index.html");
    let body = String::from_utf8(index.body().to_vec()).unwrap();

    // Don't hardcode Vite's content-hashed filename (it changes every
    // build) - read it out of the real index.html the canister just served.
    let js_path = body
        .split("src=\"/assets/")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|name| format!("/assets/{name}"))
        .expect("index.html should reference its built JS bundle under /assets/");

    let response = get(&pic, backend_id, &js_path);
    assert_eq!(response.status_code(), StatusCode::OK);
    assert_eq!(header(&response, "content-type"), Some("text/javascript"));
    assert_eq!(header(&response, "cache-control"), Some("public, max-age=31536000, immutable"));
}
