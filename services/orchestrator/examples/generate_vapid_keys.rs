//! One-time setup helper: prints a fresh VAPID (P-256 ECDSA) keypair as the
//! base64url-encoded `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars
//! `src/config.rs`/`src/push.rs` read. Run once per deployment and paste the
//! output into that deployment's environment - never commit the private key.
//!
//! `cargo run --example generate_vapid_keys`

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;
use rand::RngCore;

fn main() {
    let mut scalar = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut scalar);
    let secret_key = SecretKey::from_slice(&scalar).expect("32 random bytes are always a valid P-256 scalar");
    let public_point = secret_key.public_key().to_encoded_point(false);

    println!("VAPID_PUBLIC_KEY={}", URL_SAFE_NO_PAD.encode(public_point.as_bytes()));
    println!("VAPID_PRIVATE_KEY={}", URL_SAFE_NO_PAD.encode(secret_key.to_bytes()));
}
