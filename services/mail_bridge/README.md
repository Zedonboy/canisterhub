# mail_bridge

A two-way bridge between SMTP and canister_hub canisters, since a canister can
neither accept an inbound TCP/SMTP connection nor open an outbound one itself
(only HTTPS outcalls):

1. **Inbound**: an SMTP server receives mail addressed to a canister
   (`<principal>@MAIL_DOMAIN`), verifies it (SPF, DKIM, DMARC), and forwards
   each parsed message - annotated with the verification results - to that
   canister's `receive_mail` method via `ic-agent`.
2. **Outbound**: an HTTP API (`POST /send_mail`) a canister calls via its own
   HTTPS outcall, which this bridge DKIM-signs (if configured) and relays out
   through a configured upstream SMTP server.

`STARTTLS` (RFC 3207) is supported and offered on every inbound connection.

Verified end-to-end while building this (not just compiled): ran the real
binary against a real self-signed cert and drove a live SMTP conversation
including a genuine `STARTTLS` handshake, `EHLO` after the upgrade, and a full
message send via Python's `smtplib` - confirmed the post-STARTTLS session
correctly skips re-sending the greeting banner (a real bug this caught: RFC
3207 says go straight to `EHLO`, which an earlier version of this code got
wrong) and no longer re-advertises `STARTTLS`. Also confirmed the plaintext
path (`EHLO`/`MAIL FROM`/`RCPT TO`/`DATA` with dot-stuffing/`QUIT`) and that
`receive_mail` forwarding and `/send_mail`'s auth/relay-failure paths
genuinely reach mainnet rather than just constructing requests.

## Inbound routing

There's no alias table: a mailbox's local-part *is* the routing key -
`RCPT TO:<xkbqi-2qaaa-aaaah-qbpqa-cai@mail.example.com>` delivers to that
principal, provided the domain matches `MAIL_DOMAIN`. Mail to a
non-principal local-part or the wrong domain is rejected at `RCPT TO` time
(`550`), before `DATA` - the sender's own MTA sees this as a normal
non-existent-recipient rejection.

## Verification (SPF, DKIM, DMARC)

Every inbound message is checked via
[`mail-auth`](https://github.com/stalwartlabs/mail-auth) (same author as
`mail-parser`), using the host's system DNS resolver
(`MessageAuthenticator::new_system_conf`) - no extra DNS infrastructure to
stand up. See `src/mail/auth.rs`.

- **SPF**: checks the envelope sender's (`MAIL FROM`) domain against the
  connecting client's IP.
- **DKIM**: verifies any `DKIM-Signature` header(s) on the message against
  the signing domain's published public key.
- **DMARC**: checks SPF/DKIM alignment against the `From:` header's domain
  and the domain's published policy.

Each result (`Pass`/`Fail`/`SoftFail`/`Neutral`/`None`/`TempError`/`PermError`)
is attached to the `IncomingMail` a canister receives (`spf`/`dkim`/`dmarc`
fields, plus `tls` - whether the connection was `STARTTLS`-upgraded) - a
`receive_mail` implementation decides its own policy from there (e.g. flag a
DKIM/DMARC failure in a UI, discard an SPF softfail silently, etc.).

**The one check this bridge enforces itself**: a message whose sending domain
publishes `p=reject` in its DMARC record and fails DMARC is rejected outright
(`550`, before it ever reaches `receive_mail`) - a domain that has explicitly
asked for its failing mail to be rejected isn't a policy call worth leaving to
each canister individually. Set `DMARC_ENFORCEMENT=false` to disable this and
forward everything regardless (still annotated with the real result, just not
acted on here).

All three checks are best-effort and independent: a DNS failure or a domain
with no published record shows up as `TempError`/`PermError`/`None`, and
never blocks the message (other than the `p=reject` case above).

## The `receive_mail` interface

Any canister that wants to receive mail through this bridge implements:

```candid
type AuthResult = variant { Pass; Fail; SoftFail; Neutral; None; TempError; PermError };

type IncomingMail = record {
  envelope_from : text;
  envelope_to : vec text;
  from : text;
  to : vec text;
  subject : text;
  text_body : opt text;
  html_body : opt text;
  headers : vec record { text; text };
  received_at : nat64;
  spf : AuthResult;
  dkim : AuthResult;
  dmarc : AuthResult;
  tls : bool;
};

receive_mail : (IncomingMail) -> (variant { Ok; Err : text });
```

`envelope_from`/`envelope_to` are the SMTP-level `MAIL FROM`/`RCPT TO`;
`from`/`to` are the message's own `From:`/`To:` headers - still just what the
message claims, so a `receive_mail` implementation that needs to trust the
sender should check `dkim`/`dmarc` (aligned, cryptographic) rather than
`from` alone (unauthenticated display text) before acting on it as gospel.
`received_at` is nanoseconds since the Unix epoch, matching
`ic_cdk::api::time()`.

**A `receive_mail` implementation should also check its caller.** This
bridge signs every forwarding call with its own identity
(`IDENTITY_SEED_PHRASE`/`DEPLOY_IDENTITY_PEM`) - a canister should reject
anything not from that principal, the same way `backend/src/lib.rs` checks
`ic_cdk::api::is_controller`/verified callers elsewhere in this project:

```rust
#[ic_cdk::update]
fn receive_mail(mail: IncomingMail) -> Result<(), String> {
    if ic_cdk::api::msg_caller() != MAIL_BRIDGE_PRINCIPAL {
        return Err("only mail_bridge may call this".to_string());
    }
    // ...
}
```

## Outbound: sending mail from a canister

```rust
let request = CanisterHttpRequestArgument {
    url: "https://your-mail-bridge.example.com/send_mail".to_string(),
    method: HttpMethod::POST,
    headers: vec![
        HttpHeader { name: "Authorization".into(), value: format!("Bearer {API_KEY}") },
        HttpHeader { name: "Content-Type".into(), value: "application/json".into() },
    ],
    body: Some(serde_json::to_vec(&serde_json::json!({
        "from": "notifications@example.com",
        "to": ["someone@example.com"],
        "subject": "Hello from a canister",
        "text_body": "..."
    })).unwrap()),
    // ...
};
```

`to` accepts multiple recipients; at least one of `text_body`/`html_body` is
required (both together are sent as `multipart/alternative`). If
`DKIM_PRIVATE_KEY_PATH` is configured, the message is DKIM-signed before
being handed to the relay - see Configuration.

### Authenticating outbound requests

`POST /send_mail` checks a single static bearer token
(`MAIL_BRIDGE_API_KEY`) - every trusted canister embeds the same shared
secret and sends it as `Authorization: Bearer <key>`. This is deliberately
the simplest thing that works (matches how most canister-calls-external-API
integrations authenticate today, e.g. an embedded OpenAI key) rather than
verifying which specific canister is calling - it can't, really: an HTTPS
outcall's body isn't cryptographically signed by the calling canister unless
that canister does its own threshold-signature work first, which is a much
heavier integration than a mail bridge warrants by default. If you need
per-caller attribution, the pattern `orchestrator`'s JWT auth uses is
available to extend this: have canisters call `backend.issue_jwt()`
(inter-canister, so `msg_caller()` is the calling canister's own principal)
and send that as the bearer token instead of the shared key, with this bridge
verifying it the same way `services/orchestrator/src/auth.rs` does.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MAIL_DOMAIN` | yes | - | Domain this bridge accepts inbound mail for |
| `MAIL_BRIDGE_API_KEY` | yes | - | Bearer token `POST /send_mail` requires |
| `SMTP_RELAY_HOST` | yes | - | Upstream SMTP server outbound mail is relayed through |
| `SMTP_RELAY_PORT` | no | `587` | |
| `SMTP_RELAY_USERNAME` | no | - | Omit for an unauthenticated relay |
| `SMTP_RELAY_PASSWORD` | no | - | |
| `SMTP_RELAY_TLS` | no | `starttls` | `starttls` (plaintext then upgrade, port 587's convention) or `wrapper` (TLS from the first byte, port 465's convention) - must match what `SMTP_RELAY_HOST`/`SMTP_RELAY_PORT` actually speak, since the two don't degrade into each other |
| `TLS_CERT_PATH` | yes | - | PEM certificate (chain) `STARTTLS` presents |
| `TLS_KEY_PATH` | yes | - | PEM private key for `TLS_CERT_PATH` (PKCS1/PKCS8/SEC1, auto-detected) |
| `DMARC_ENFORCEMENT` | no | `true` | Reject mail failing DMARC when the domain publishes `p=reject` |
| `DKIM_PRIVATE_KEY_PATH` | no | - | RSA or Ed25519 PEM key to sign outbound mail with (PKCS1/PKCS8/SEC1, auto-detected); unset = send unsigned |
| `DKIM_SELECTOR` | no | `default` | DKIM selector (must match a `<selector>._domainkey.<domain>` DNS TXT record) |
| `DKIM_DOMAIN` | no | `MAIL_DOMAIN` | Domain to sign outbound DKIM as, if different from the inbound one |
| `IDENTITY_SEED_PHRASE` | one of these two | - | BIP-39 seed phrase, derived the same way `dfx` does |
| `DEPLOY_IDENTITY_PEM` | one of these two | - | Path to a Secp256k1 or Ed25519 PEM |
| `IC_URL` | no | `https://ic0.app` | Replica URL |
| `IC_LOCAL` | no | `false` | Set `true` only for a local/test replica (fetches its root key) |
| `SMTP_BIND_ADDR` | no | `0.0.0.0:2525` | Inbound SMTP listen address |
| `HTTP_BIND_ADDR` | no | `0.0.0.0:8788` | Outbound HTTP API listen address |
| `MAX_MESSAGE_BYTES` | no | `26214400` (25 MiB) | Inbound message size cap |

## Running

```sh
export MAIL_DOMAIN=mail.example.com
export MAIL_BRIDGE_API_KEY=$(openssl rand -hex 32)
export SMTP_RELAY_HOST=smtp.your-provider.com
export SMTP_RELAY_USERNAME=...
export SMTP_RELAY_PASSWORD=...
export IDENTITY_SEED_PHRASE="your twelve or twenty-four word seed phrase"
export TLS_CERT_PATH=./cert.pem
export TLS_KEY_PATH=./key.pem
cargo run
```

For local testing, a self-signed cert is enough:

```sh
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj "/CN=$MAIL_DOMAIN"
```

For production, use a real certificate (e.g. Let's Encrypt) - clients doing
proper certificate validation on `STARTTLS` will otherwise fall back to
unencrypted delivery or refuse to connect, depending on their own policy.

To actually receive internet mail you need an MX record for `MAIL_DOMAIN`
pointing at this host, and for DKIM/SPF/DMARC to mean anything for your
*outbound* mail, the corresponding DNS records on your side too: an SPF TXT
record authorizing `SMTP_RELAY_HOST` (or whatever it forwards through) to
send for your domain, a `<DKIM_SELECTOR>._domainkey.<DKIM_DOMAIN>` TXT record
publishing the public half of `DKIM_PRIVATE_KEY_PATH`, and a `_dmarc.<domain>`
TXT record stating your policy.

## Limitations

- **No `AUTH`, no `BDAT` chunking.** `PIPELINING` (RFC 2920) is advertised and
  supported for free - the server reads and executes commands strictly in
  order off the wire, so a client batching `MAIL FROM`/`RCPT TO`/`DATA`
  without waiting for each reply already works with no extra buffering logic.
  `AUTH` is intentionally out of scope: this bridge isn't meant to be an open
  submission relay for arbitrary senders, only an inbound gateway plus an
  `Authorization`-header-gated `POST /send_mail` for canisters (see
  "Authenticating outbound requests" above) - so there's no outbound-facing
  SMTP client identity for `AUTH` to protect. `BDAT` (RFC 3030, chunked `DATA`
  as an alternative to dot-stuffing) has no client-side benefit here since
  every real-world client falls back to plain `DATA` when it isn't advertised.
- **DKIM signing supports RSA and Ed25519**, auto-detected from
  `DKIM_PRIVATE_KEY_PATH`'s key type (a PKCS1 PEM is unambiguously RSA; a
  PKCS8 PEM is tried as RSA first, then Ed25519). A raw EC/SEC1 key (e.g.
  P-256) is rejected at startup - DKIM only defines RSA-SHA256 and
  Ed25519-SHA256, so there is no third algorithm to fall back to.
- **Bounces/DSNs are sent** (`src/mail/dsn.rs`) when forwarding to a canister
  fails after `DATA` was already accepted (`250`): an RFC 3464
  `multipart/report; report-type=delivery-status` message is relayed back to
  the envelope sender, with a null reverse-path (`MAIL FROM:<>`, per RFC 5321
  §4.5.5) so a bad bounce address can't itself trigger a bounce loop. A DSN is
  only attempted when the original envelope-from is non-empty (a message that
  was itself a bounce, `MAIL FROM:<>`, is dropped silently rather than
  answered) - see `mail::dsn::maybe_send`.
- **Outbound delivery is only as good as `SMTP_RELAY_HOST`'s reputation** -
  this bridge doesn't attempt direct-to-recipient delivery (which gets
  spam-filtered without your own reverse DNS/SPF/DKIM infrastructure), so use
  a real transactional-email provider's SMTP endpoint as the relay.
- **DMARC/SPF/DKIM verification tells you the sending domain's own claims
  checked out - not that the message is safe or wanted.** These stop domain
  spoofing, not spam or phishing from a legitimately-authenticated but
  malicious sender.
