# canister-hub-sdk

Typed Rust clients and canister-side building blocks for the Candid APIs exposed by:

- `packages/ic-sql`
- `packages/ic-kv`
- `packages/auth`

The SDK has three implementation façades:

- `client`: native/off-chain `ic-agent` clients (the default feature)
- `browser`: `wasm-bindgen` JavaScript clients (`browser` feature)
- `ic`: bounded inter-canister clients, stable-memory building blocks, and
  the `ic::config` dynamic-config module for Marketplace Module canisters

The legacy `agent`, `js`, and `canister` feature names remain aliases for
`client`, `browser`, and `ic`. The crate copies only the public Candid wire
types; it does not link the canister implementations or their exported entry
points.

## Rust

Add the crate by path while developing in this repository:

```toml
[dependencies]
canister-hub-sdk = { path = "../sdk" }
ic-agent = "0.49"
```

Create one `ic-agent::Agent` with the identity and network configuration your
application needs, then share it across clients:

```rust,no_run
use canister_hub_sdk::{client::{KvClient, SqlClient}, kv::Value};
use ic_agent::Agent;
use std::sync::Arc;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let agent = Arc::new(Agent::builder()
    .with_url("https://icp-api.io")
    .build()?);

let sql = SqlClient::from_text(agent.clone(), "aaaaa-aa")?;
let kv = KvClient::from_text(agent, "aaaaa-aa")?;

let tables = sql.list_tables().await?;
let previous = kv.set("theme", Value::Text("dark".into())).await?;
# Ok(())
# }
```

For a local replica, call `agent.fetch_root_key().await?` once after building
the agent. Never fetch a root key when connecting to mainnet. Pass an
identity-configured agent to use `auth`'s principal-scoped or controller-only
methods.

### From another Rust canister

Disable the off-chain client and enable bounded `ic-cdk` transport:

```toml
[dependencies]
canister-hub-sdk = { path = "../sdk", default-features = false, features = ["ic"] }
```

```rust,no_run
use canister_hub_sdk::{ic::SqlClient, Principal};

# async fn example(database_id: Principal) -> canister_hub_sdk::Result<()> {
let database = SqlClient::for_canister(database_id);
let rows = database.query("SELECT * FROM users").await?;
# Ok(())
# }
```

The canister transport uses bounded calls and returns rejections as `Error`.
Treat an unknown outcome carefully before retrying a non-idempotent operation.

Pass the auth canister principal resolved by the host application at runtime
to `ic::auth(auth_canister_id)`. The SDK does not read environment variables
or decide how canister IDs are discovered. It reuses one `AuthClient` per
runtime canister ID. Successful `authorize_principal` results are cached for 5
seconds; fetched profiles and trusted principal claims are cached for 60
seconds. Clones share cache entries. Session-based claims are never inserted
into the principal cache. This reduces repeated inter-canister auth calls while
bounding the revocation/staleness window. Both durations are configurable and
both caches can be cleared explicitly.

Use `resolve_principal(principal)` from a canister included in auth's
`trusted_canisters` configuration to obtain the user's profile ID, principal,
display name, email, and avatar URL. Use `resolve_session(token)` when the
OAuth bearer session is the authority; session claims are deliberately fetched
fresh on every call.

The `ic::storage` module re-exports the stable-memory manager and structures
needed for orthogonal storage. The consuming canister owns its memory layout
and must assign unique `MemoryId`s.

## Module permissions / ACL

Implement `permissions::PermissionStore`, then invoke the macro once at the
canister crate root:

```rust,ignore
use canister_hub_sdk::permissions::{Access, PermissionEntry, PermissionStore};

struct Store;

impl PermissionStore for Store {
    fn get(module: &str, principal: &candid::Principal) -> Option<Access> {
        // Read from this package's own stable storage.
        todo!()
    }

    fn set(entry: PermissionEntry) -> Result<(), String> { todo!() }
    fn remove(module: &str, principal: &candid::Principal) -> Result<(), String> { todo!() }
    fn list(module: Option<&str>) -> Vec<PermissionEntry> { todo!() }
}

canister_hub_sdk::permission_api!(Store);
ic_cdk::export_candid!();
```

The macro exports `get_permission`, `list_permissions`, `set_permission`, and
`remove_permission`. Reads are public. Writes are controller-only and module
names are validated before the package store is called. Application methods
must still enforce `Access` themselves; the generated API manages ACL data but
does not replace checks inside protected methods.

All three transports can use `permissions::PermissionClient` to call this
generated interface.

## Marketplace Module dynamic config (`ic` feature only)

`ic::config` generates a standardized `get_config_schema`/`get_config`/
`set_config` Candid surface for a Marketplace Module canister, backed by
stable-memory persistence and a process-local env mirror internal code can
read without touching Candid:

```rust,ignore
use canister_hub_sdk::ic::config::dynamic_config;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use ic_stable_structures::DefaultMemoryImpl;
use std::cell::RefCell;

#[dynamic_config]
#[config_urls(admin_panel_url = "https://{canister_id}.icp0.io/admin", home_page_url = "https://{canister_id}.icp0.io/")]
pub struct ModuleConfig {
    #[config(label = "Greeting", default = "Hello!")]
    pub greeting: String,

    #[config(label = "Retry Count")] // no default -> required
    pub retry_count: i64,

    #[config(label = "API Key", secret)] // masked in get_config for non-controllers
    pub api_key: Option<String>,

    #[config(label = "Build Hash", readonly)] // displayed, never editable through set_config
    pub build_hash: Option<String>,

    // Optional typed canister picker. Omitting canister_type means custom.
    #[config(label = "Auth Canister", canister_type = "auth")]
    pub auth_canister: Option<candid::Principal>,
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
}

// Call from *both* #[init] and #[post_upgrade] with the same MemoryId - the
// SDK never creates its own MemoryManager (see ic::config's doc comment).
fn init_module_config() {
    canister_hub_sdk::ic::config::init_stable_store::<ModuleConfig>(
        MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(10))),
    );
    canister_hub_sdk::ic::config::set_readonly::<ModuleConfig>(
        "build_hash",
        canister_hub_sdk::ic::config::ConfigValue::Text("abc123".into()),
    )
    .expect("valid read-only value");
}

#[ic_cdk::init]
fn init() {
    init_module_config();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_module_config();
}

// Internal code reads config via the env mirror, updated on
// init/post_upgrade and on every successful set_config.
fn greet() -> String {
    canister_hub_sdk::ic::config::get_env_text("greeting").unwrap_or_default()
}

ic_cdk::export_candid!();
```

`#[dynamic_config]` also adds `#[derive(candid::CandidType, serde::Deserialize, Clone, Debug)]`
to the struct. Use `#[derive(canister_hub_sdk::ic::config::DynamicConfig)]`
instead if you'd rather add your own derives - same field-attribute grammar,
but it only adds the `ConfigSchema` impl and the five endpoints. Use exactly
one such struct per canister crate; see `ic::config`'s module docs (`cargo
doc --no-default-features --features ic --open`) for the full field-attribute
reference, stable-memory ownership model, and endpoint semantics (`set_config`
is controller-only; `get_config` masks `SecretText` fields for non-controllers).

The optional struct-level `#[config_urls(...)]` generates two more public
queries, `get_admin_panel_url`/`get_home_page_url` (both `Option<String>`,
`None` if that URL wasn't declared) - what a dashboard's canister card calls
to decide whether to show an "Open Admin Panel"/"Open Home Page" action.
`{canister_id}` in either literal is substituted at call time with this
canister's own principal, since that's almost always what the URL needs.

## JavaScript / WebAssembly

Build with `wasm-pack`:

```sh
cd sdk
wasm-pack build --target bundler -- --no-default-features --features browser
```

The generated package exports `IcSqlClient`, `IcKvClient`, `AuthClient`, and
`PermissionClient`:

```js
import init, { IcKvClient } from "./sdk/pkg/canister_hub_sdk.js";

await init();
const kv = await IcKvClient.create(
  "http://127.0.0.1:8000",
  "<ic-kv-canister-id>",
  true, // fetch the local replica root key; use false on mainnet
);

await kv.set("theme", { Text: "dark" });
console.log(await kv.get("theme"));
```

Wasm clients use an anonymous `ic-agent` identity. That covers the open
`ic-sql`/`ic-kv` methods and auth's OAuth-session flow (`beginOAuth` with
`link = false`, followed by `getProfileBySession`). Principal-scoped auth
methods require the Rust API with an identity-configured `Agent`.

JavaScript values mirror Candid variants, for example `{ Text: "hello" }`,
`{ Integer: 42n }`, `{ Bytes: new Uint8Array([1, 2]) }`, or the string
`"Null"`. Returned `u64`/`i64` values are JavaScript `bigint`s so timestamps
and identifiers remain lossless.
