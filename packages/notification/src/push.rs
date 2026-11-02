//! End-to-end Web Push cryptography and delivery for the notification module.
//!
//! Subscription persistence and access control stay in `lib.rs`; this module
//! implements the protocol-specific pieces: VAPID ES256 JWTs, RFC 8291
//! `aes128gcm` payload encryption, endpoint validation, and the single-node
//! HTTPS POST that avoids one notification per subnet replica.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use ic_cdk::management_canister::{
    http_request, raw_rand, HttpHeader, HttpMethod, HttpRequestArgs,
};
use p256::ecdh::diffie_hellman;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{EncodedPoint, PublicKey, SecretKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

const WEB_PUSH_INFO_PREFIX: &[u8] = b"WebPush: info\0";
const CEK_INFO: &[u8] = b"Content-Encoding: aes128gcm\0";
const NONCE_INFO: &[u8] = b"Content-Encoding: nonce\0";
const RECORD_SIZE: u32 = 4_096;
// Keeps the complete aes128gcm body (salt + record metadata + ephemeral key
// + ciphertext/tag) below the 4 KiB limit enforced by common push services.
const MAX_PLAINTEXT_BYTES: usize = 3_800;
const MAX_RESPONSE_BYTES: u64 = 4_096;
const VAPID_TTL_SECONDS: u64 = 12 * 60 * 60;

#[derive(Clone, Debug, Serialize)]
pub struct NotificationPayload<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub url: &'a str,
}

pub struct PreparedPush {
    pub endpoint: String,
    pub body: Vec<u8>,
    pub authorization: String,
}

pub fn decode_private_key(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| "VAPID private key must be unpadded base64url".to_string())?;
    SecretKey::from_slice(&bytes)
        .map_err(|_| "VAPID private key is not a valid P-256 scalar".to_string())?;
    Ok(bytes)
}

pub fn public_key(private_key: &[u8]) -> Result<Vec<u8>, String> {
    let secret = SecretKey::from_slice(private_key)
        .map_err(|_| "stored VAPID private key is invalid".to_string())?;
    Ok(secret
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec())
}

pub fn public_key_base64(private_key: &[u8]) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(public_key(private_key)?))
}

pub fn validate_subject(subject: &str) -> Result<(), String> {
    if subject.starts_with("mailto:") && subject.len() > "mailto:".len() {
        return Ok(());
    }
    if subject.starts_with("https://") && Url::parse(subject).is_ok() {
        return Ok(());
    }
    Err("VAPID subject must be a non-empty mailto: address or HTTPS URL".to_string())
}

pub fn validate_subscription(endpoint: &str, p256dh: &str, auth: &str) -> Result<(), String> {
    endpoint_origin(endpoint)?;
    let user_public = decode_key("p256dh", p256dh)?;
    PublicKey::from_sec1_bytes(&user_public)
        .map_err(|_| "p256dh is not a valid P-256 public key".to_string())?;
    let auth = decode_key("auth", auth)?;
    if auth.len() != 16 {
        return Err("auth must decode to exactly 16 bytes".to_string());
    }
    Ok(())
}

fn decode_key(label: &str, value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("{label} must be unpadded base64url"))
}

fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    let url = Url::parse(endpoint).map_err(|_| "push endpoint is not a valid URL".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("push endpoint must be a public HTTPS URL".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn hkdf_expand(
    salt: Option<&[u8]>,
    ikm: &[u8],
    info: &[u8],
    len: usize,
) -> Result<Vec<u8>, String> {
    let hkdf = Hkdf::<Sha256>::new(salt, ikm);
    let mut output = vec![0; len];
    hkdf.expand(info, &mut output)
        .map_err(|_| "Web Push HKDF expansion failed".to_string())?;
    Ok(output)
}

fn vapid_jwt(
    private_key: &[u8],
    subject: &str,
    audience: &str,
    now_seconds: u64,
) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let payload = serde_json::json!({
        "aud": audience,
        "exp": now_seconds + VAPID_TTL_SECONDS,
        "sub": subject,
    });
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&payload).map_err(|e| format!("failed to encode VAPID JWT: {e}"))?,
    );
    let signing_input = format!("{header}.{payload}");
    let signing_key = SigningKey::from_slice(private_key)
        .map_err(|_| "stored VAPID private key is invalid".to_string())?;
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

fn encrypt_payload(
    subscription_public: &[u8],
    auth_secret: &[u8],
    ephemeral_private: &[u8],
    salt: &[u8],
    plaintext: &[u8],
) -> Result<(Vec<u8>, EncodedPoint), String> {
    let user_public = PublicKey::from_sec1_bytes(subscription_public)
        .map_err(|_| "p256dh is not a valid P-256 public key".to_string())?;
    let ephemeral_secret = SecretKey::from_slice(ephemeral_private).map_err(|_| {
        "raw_rand produced an invalid P-256 scalar; retry the notification".to_string()
    })?;
    let server_public = ephemeral_secret.public_key().to_encoded_point(false);
    let shared = diffie_hellman(
        ephemeral_secret.to_nonzero_scalar(),
        user_public.as_affine(),
    );

    let mut key_info = Vec::with_capacity(
        WEB_PUSH_INFO_PREFIX.len() + subscription_public.len() + server_public.as_bytes().len(),
    );
    key_info.extend_from_slice(WEB_PUSH_INFO_PREFIX);
    key_info.extend_from_slice(subscription_public);
    key_info.extend_from_slice(server_public.as_bytes());

    let ikm = hkdf_expand(Some(auth_secret), shared.raw_secret_bytes(), &key_info, 32)?;
    let cek = hkdf_expand(Some(salt), &ikm, CEK_INFO, 16)?;
    let nonce = hkdf_expand(Some(salt), &ikm, NONCE_INFO, 12)?;

    let mut record = plaintext.to_vec();
    record.push(2); // RFC 8188 final-record delimiter.
    let cipher = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| "failed to initialize Web Push encryption".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), record.as_ref())
        .map_err(|_| "failed to encrypt Web Push payload".to_string())?;

    let mut body =
        Vec::with_capacity(16 + 4 + 1 + server_public.as_bytes().len() + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(server_public.as_bytes().len() as u8);
    body.extend_from_slice(server_public.as_bytes());
    body.extend_from_slice(&ciphertext);
    Ok((body, server_public))
}

pub async fn prepare(
    private_key: &[u8],
    subject: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &NotificationPayload<'_>,
) -> Result<PreparedPush, String> {
    let audience = endpoint_origin(endpoint)?;
    let subscription_public = decode_key("p256dh", p256dh)?;
    let auth_secret = decode_key("auth", auth)?;
    validate_subscription(endpoint, p256dh, auth)?;

    let ephemeral_private = raw_rand()
        .await
        .map_err(|e| format!("raw_rand failed for Web Push key: {e}"))?;
    let salt_seed = raw_rand()
        .await
        .map_err(|e| format!("raw_rand failed for Web Push salt: {e}"))?;
    let salt = &Sha256::digest(&salt_seed)[..16];
    let plaintext =
        serde_json::to_vec(payload).map_err(|e| format!("failed to encode notification: {e}"))?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(format!(
            "encoded notification is too large ({} bytes; maximum {MAX_PLAINTEXT_BYTES})",
            plaintext.len()
        ));
    }
    let (body, _) = encrypt_payload(
        &subscription_public,
        &auth_secret,
        &ephemeral_private,
        salt,
        &plaintext,
    )?;
    let jwt = vapid_jwt(
        private_key,
        subject,
        &audience,
        ic_cdk::api::time() / 1_000_000_000,
    )?;
    let public = public_key_base64(private_key)?;

    Ok(PreparedPush {
        endpoint: endpoint.to_string(),
        body,
        authorization: format!("vapid t={jwt}, k={public}"),
    })
}

pub async fn deliver(prepared: PreparedPush) -> Result<u16, String> {
    let response = http_request(&HttpRequestArgs {
        url: prepared.endpoint,
        method: HttpMethod::POST,
        headers: vec![
            HttpHeader {
                name: "Authorization".to_string(),
                value: prepared.authorization,
            },
            HttpHeader {
                name: "Content-Encoding".to_string(),
                value: "aes128gcm".to_string(),
            },
            HttpHeader {
                name: "Content-Type".to_string(),
                value: "application/octet-stream".to_string(),
            },
            HttpHeader {
                name: "TTL".to_string(),
                value: "86400".to_string(),
            },
        ],
        body: Some(prepared.body),
        max_response_bytes: Some(MAX_RESPONSE_BYTES),
        transform: None,
        // A replicated POST would make every subnet node deliver the same
        // notification. Web Push is a side effect, so exactly one node sends.
        is_replicated: Some(false),
    })
    .await
    .map_err(|e| format!("push-service HTTPS outcall failed: {e}"))?;
    response
        .status
        .0
        .try_into()
        .map_err(|_| "push service returned an invalid HTTP status".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_vapid_subjects_and_https_endpoints() {
        assert!(validate_subject("mailto:ops@example.com").is_ok());
        assert!(validate_subject("https://example.com/contact").is_ok());
        assert!(validate_subject("ops@example.com").is_err());
        assert_eq!(
            endpoint_origin("https://push.example/send/1").unwrap(),
            "https://push.example"
        );
        assert!(endpoint_origin("http://push.example/send/1").is_err());
    }

    #[test]
    fn encryption_matches_rfc_8291_section_5_vector() {
        let auth = decode_key("auth", "BTBZMqHH6r4Tts7J_aSIgg").unwrap();
        let receiver_public = decode_key(
            "receiver",
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        )
        .unwrap();
        let sender_private =
            decode_key("sender", "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap();
        let salt = decode_key("salt", "DGv6ra1nlYgDCS1FRnbzlw").unwrap();
        let (body, _) = encrypt_payload(
            &receiver_public,
            &auth,
            &sender_private,
            &salt,
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }
}
