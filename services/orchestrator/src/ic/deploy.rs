//! Canister creation + code install. Two networks, two very different ways to pay
//! for creation:
//!
//! - `local`: a local/test replica accepts `provisional_create_canister_with_cycles`
//!   (management canister minting cycles out of thin air) - this is disabled on
//!   mainnet.
//! - `ic` (mainnet): creation must be funded by a real cycles wallet the caller's
//!   identity controls (the standard dfx `wallet_create_canister` flow). The
//!   identity is also added as a canister controller so `install_code` can be
//!   called directly afterwards instead of forwarding it through the wallet.

use candid::Principal;
use ic_agent::Agent;
use ic_management_canister_types::UploadChunkArgs;
use ic_utils::call::AsyncCall;
use ic_utils::interfaces::management_canister::builders::CanisterInstallMode;
use ic_utils::interfaces::wallet::WalletCanister;
use ic_utils::interfaces::ManagementCanister;
use sha2::{Digest, Sha256};

pub struct DeployOutcome {
    pub canister_id: Principal,
}

/// Above this, `install` uploads `wasm` in chunks rather than in one
/// `install_code` call - matches the ~1.85MiB cutoff `ic-utils`' own
/// (broken - see below) auto-chunking uses, kept well under it for margin.
const CHUNKED_INSTALL_THRESHOLD: usize = 1_800_000;
/// Matches `ic-utils`' own chunk size for `upload_chunk`.
const CHUNK_SIZE: usize = 1024 * 1024;

/// Installs `wasm` on `canister_id`, splitting it into ≤1MiB chunks
/// (`upload_chunk` + `install_chunked_code`) above [`CHUNKED_INSTALL_THRESHOLD`]
/// rather than sending it in one `install_code` call.
///
/// This duplicates something `ic-utils`'s own `InstallCodeBuilder::
/// call_and_wait` already claims to do automatically past its own ~1.85MiB
/// cutoff - reimplemented by hand here because that automatic path doesn't
/// actually work: verified directly (a standalone probe against a real
/// PocketIC instance, calling `install_code().call_and_wait()` exactly as
/// this function used to) that a module past the cutoff still fails
/// outright with a transport-level "413 Payload Too Large", the same way an
/// un-chunked single call would - the whole module gets sent in one request
/// regardless of size. The individual `upload_chunk`/`install_chunked_code`
/// calls work correctly when driven directly (also verified against the
/// same instance); only `ic-utils`'s automatic *dispatch* between the two
/// paths is broken. Below the threshold this still goes through the
/// ordinary single-call path - no reason to chunk something small.
async fn install(agent: &Agent, canister_id: Principal, wasm: &[u8]) -> anyhow::Result<()> {
    let mgmt = ManagementCanister::create(agent);

    if wasm.len() < CHUNKED_INSTALL_THRESHOLD {
        mgmt.install_code(&canister_id, wasm)
            .with_mode(CanisterInstallMode::Install)
            .with_raw_arg(b"DIDL\0\0".to_vec())
            .build()?
            .call_and_wait()
            .await?;
        return Ok(());
    }

    let mut chunk_hashes = Vec::new();
    for chunk in wasm.chunks(CHUNK_SIZE) {
        let (result,) = mgmt
            .upload_chunk(
                &canister_id,
                &UploadChunkArgs {
                    canister_id,
                    chunk: chunk.to_vec(),
                },
            )
            .call_and_wait()
            .await
            .map_err(|e| anyhow::anyhow!("upload_chunk failed: {e}"))?;
        chunk_hashes
            .push(ic_utils::interfaces::management_canister::ChunkHash { hash: result.hash });
    }

    let wasm_module_hash = Sha256::digest(wasm).to_vec();
    mgmt.install_chunked_code(&canister_id, &wasm_module_hash)
        .with_chunk_hashes(chunk_hashes)
        .with_raw_arg(b"DIDL\0\0".to_vec())
        .with_install_mode(CanisterInstallMode::Install)
        .build()?
        .call_and_wait()
        .await
        .map_err(|e| anyhow::anyhow!("install_chunked_code failed: {e}"))?;
    Ok(())
}

/// Local/test replica path: mint cycles provisionally, no wallet needed.
///
/// `effective_canister_id_hint` - any already-known real canister id, e.g.
/// `Config::marketplace_canister_id` - is passed as `ic-utils`'
/// `with_effective_canister_id`, overriding its own default (the management
/// canister's own id, `aaaaa-aa`). Without this, `ic-utils` routes this
/// call's `read_state` polling using that default, and PocketIC's HTTP
/// gateway - unlike a real replica, which handles the default fine - can
/// come back with a certificate for a subnet whose `canister_ranges` don't
/// actually cover the newly created canister, failing the whole call with
/// `ic-agent`'s own "lookup path ... is unknown in the certificate" error.
/// Passing a real, already-known canister id sidesteps this by routing to a
/// subnet the gateway can certify correctly - harmless (if unnecessary)
/// against a real replica too, so this isn't PocketIC-only special-casing.
pub async fn create_and_install_local(
    agent: &Agent,
    caller: Principal,
    cycles: u128,
    wasm: &[u8],
    effective_canister_id_hint: Principal,
) -> anyhow::Result<DeployOutcome> {
    let mgmt = ManagementCanister::create(agent);
    let (canister_id,) = mgmt
        .create_canister()
        .as_provisional_create_with_amount(Some(cycles))
        .with_effective_canister_id(effective_canister_id_hint)
        .with_controller(caller)
        .build()?
        .call_and_wait()
        .await?;

    install(agent, canister_id, wasm).await?;
    Ok(DeployOutcome { canister_id })
}

/// Mainnet path: fund + create via the configured cycles wallet, install directly.
pub async fn create_and_install_mainnet(
    agent: &Agent,
    wallet_canister_id: Principal,
    caller: Principal,
    cycles: u128,
    wasm: &[u8],
) -> anyhow::Result<DeployOutcome> {
    let wallet = WalletCanister::create(agent, wallet_canister_id).await?;
    let result = wallet
        .wallet_create_canister(cycles, Some(vec![caller]), None, None, None)
        .await
        .map_err(|e| anyhow::anyhow!("wallet_create_canister failed: {e}"))?;

    install(agent, result.canister_id, wasm).await?;
    Ok(DeployOutcome {
        canister_id: result.canister_id,
    })
}
