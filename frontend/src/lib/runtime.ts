// Real, direct-from-the-browser WASM runtime deploys - the Runtime page's
// counterpart to `lib/deploy.ts` (marketplace items) and `lib/canisterOps.ts`
// (stop/start/delete). Here the wasm comes straight from the user's own file
// picker instead of a marketplace URL: create a canister, install the
// uploaded bytes, set controllers to `[user, orchestrator]`, and record the
// result on the project - the same real IC management-canister calls, made
// with the signed-in user's own identity. No orchestrator HTTP call
// anywhere in this file.
//
// New canisters are funded and created through the Cycles Ledger on every
// network. Once the ledger returns the new canister id, management-canister
// calls are routed with that id as their effective canister id.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { idlFactory as managementIdlFactory, MANAGEMENT_CANISTER_ID, type ManagementService } from "./candid/management";
import {
  CYCLES_LEDGER_CANISTER_ID,
  idlFactory as cyclesLedgerIdlFactory,
  type CyclesLedgerCreateCanisterError,
  type CyclesLedgerWithdrawError,
  type CyclesLedgerService,
} from "./candid/cyclesLedger";
import { addProjectCanisters } from "./backend";
import type { Project, CanisterInfo, CanisterKind } from "./backend";
import { runtimeValue } from "./canisterEnv";
import { getCanisterMetadata } from "./canisterMetadata";
import type { CanisterMetadata } from "./candid/canisterMetadata";
import { hasModuleConfig } from "./moduleConfig";
import { readPublicInfo } from "./canisterStats";

/** Maps the uploaded module's own self-declared `canister_metadata!`
 * `canister_type` (if any - see `canisterMetadata.ts::getCanisterMetadata`)
 * onto this project's `CanisterKind`, so e.g. an uploaded Auth-type module
 * lands in `listAuthCanisters` instead of sitting as an undifferentiated
 * `"other"` runtime blob. Only `Auth`/`Database` have an unambiguous
 * `CanisterKind` counterpart. Storage modules use the existing `static`
 * kind, which is what the Storage service consumes. `Custom` (and a module
 * that declares no type at all, or doesn't implement `canister_metadata!`
 * at all) falls back to `"other"`. */
function canisterKindFromMetadata(metadata: CanisterMetadata | null): CanisterKind {
  if (metadata?.name.toLowerCase().trim().replaceAll("-", "_") === "notification") return "notification";
  const type = metadata?.canister_type[0];
  if (type && "Auth" in type) return "auth";
  if (type && "Database" in type) return "database";
  if (type && "Storage" in type) return "static";
  return "other";
}

/** Every runtime canister this page deployed is named with this prefix, so
 * `listRuntimeCanisters` can tell them apart from other `"other"`-kind
 * canisters a project may hold (e.g. a generic marketplace install from
 * `InstallCanisterDialog`) without needing a dedicated backend
 * `CanisterKind` variant of its own. Only covers `"other"`-kind deploys: one
 * that `deployWasmRuntime` detected as Auth/Database/Storage moves to that kind's
 * own list (e.g. `listAuthCanisters`) instead and no longer shows up here -
 * intended, not a bug. */
const RUNTIME_PREFIX = "runtime-";
const INITIAL_CANISTER_CYCLES = 2_000_000_000_000n;
const DIRECT_INSTALL_LIMIT = 1_500_000;
const WASM_CHUNK_SIZE = 1_000_000;

export interface RuntimeCanister {
  name: string;
  id: string;
}

export interface DeployedRuntimeCanister extends RuntimeCanister {
  kind: CanisterKind;
  /** Whether the deployed module implements `canister-hub-sdk`'s
   * `ic::config` surface at all (see `moduleConfig.ts::hasModuleConfig`) -
   * lets `Runtime.tsx` skip navigating to a Settings page that would have
   * nothing to show. */
  hasConfig: boolean;
}

/** This project's own wasm-runtime canisters - see `RUNTIME_PREFIX` above. */
export function listRuntimeCanisters(project: Project): RuntimeCanister[] {
  return Object.entries(project.canisters)
    .filter(([name, info]: [string, CanisterInfo]) => info.kind === "other" && name.startsWith(RUNTIME_PREFIX))
    .map(([name, info]) => ({ name, id: info.id }));
}

async function managementActor(network: string, effectiveCanisterId: Principal): Promise<ManagementService> {
  const agent = await getAgent(network);
  return Actor.createActor<ManagementService>(managementIdlFactory, {
    agent,
    canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
    effectiveCanisterId,
  });
}

async function cyclesLedgerActor(network: string): Promise<CyclesLedgerService> {
  const agent = await getAgent(network);
  return Actor.createActor<CyclesLedgerService>(cyclesLedgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(CYCLES_LEDGER_CANISTER_ID),
  });
}

function cyclesLedgerErrorMessage(error: CyclesLedgerCreateCanisterError): string {
  if ("InsufficientFunds" in error) {
    return `Insufficient Cycles Ledger balance: ${error.InsufficientFunds.balance} cycles available; at least ${INITIAL_CANISTER_CYCLES} cycles plus the ledger fee are required.`;
  }
  if ("FailedToCreate" in error) return `Cycles Ledger could not create the canister: ${error.FailedToCreate.error}`;
  if ("GenericError" in error) return `Cycles Ledger error ${error.GenericError.error_code}: ${error.GenericError.message}`;
  if ("TemporarilyUnavailable" in error) return "The Cycles Ledger is temporarily unavailable.";
  if ("CreatedInFuture" in error) return `The Cycles Ledger rejected the request timestamp; ledger time is ${error.CreatedInFuture.ledger_time}.`;
  if ("TooOld" in error) return "The Cycles Ledger rejected the request because it is too old.";
  return `The Cycles Ledger reported a duplicate request at block ${error.Duplicate.duplicate_of}, but did not return a canister id.`;
}

function cyclesLedgerWithdrawErrorMessage(error: CyclesLedgerWithdrawError): string {
  if ("InsufficientFunds" in error) return `Insufficient Cycles Ledger balance: ${error.InsufficientFunds.balance} cycles available.`;
  if ("FailedToWithdraw" in error) return `The target canister rejected the deposit: ${error.FailedToWithdraw.rejection_reason}`;
  if ("BadFee" in error) return `Wrong fee - the Cycles Ledger expected ${error.BadFee.expected_fee}.`;
  if ("GenericError" in error) return `Cycles Ledger error ${error.GenericError.error_code}: ${error.GenericError.message}`;
  if ("TemporarilyUnavailable" in error) return "The Cycles Ledger is temporarily unavailable.";
  if ("CreatedInFuture" in error) return `The Cycles Ledger rejected the request timestamp; ledger time is ${error.CreatedInFuture.ledger_time}.`;
  if ("TooOld" in error) return "The Cycles Ledger rejected the request because it is too old.";
  return `The Cycles Ledger reported a duplicate request at block ${error.Duplicate.duplicate_of}.`;
}

/** Real `withdraw` - tops up an *existing* canister directly from the
 * caller's own Cycles Ledger balance (see `candid/cyclesLedger.ts`'s own
 * doc comment on `withdraw`). Used by the Usage Breakdown's per-canister
 * top-up action (`Wallet.tsx`) - a real cycles deposit, not the mock
 * "Top Up Cycles" dialog's ICP-flow placeholder. Returns the real ledger
 * block index on success. */
export async function topUpCanister(canisterId: string, network: string, amount: bigint): Promise<bigint> {
  const actor = await cyclesLedgerActor(network);
  const result = await actor.withdraw({
    to: Principal.fromText(canisterId),
    from_subaccount: [],
    created_at_time: [],
    amount,
  });
  if ("Err" in result) throw new Error(cyclesLedgerWithdrawErrorMessage(result.Err));
  return result.Ok;
}

async function createCanisterWithCyclesLedger(
  network: string,
  controllers: Principal[],
): Promise<Principal> {
  const ledger = await cyclesLedgerActor(network);
  const result = await ledger.create_canister({
    from_subaccount: [],
    created_at_time: [],
    amount: INITIAL_CANISTER_CYCLES,
    creation_args: [{
      settings: [{
        controllers: [controllers],
        compute_allocation: [],
        memory_allocation: [],
        freezing_threshold: [],
        reserved_cycles_limit: [],
      }],
      subnet_selection: [],
    }],
  });

  if ("Ok" in result) return result.Ok.canister_id;
  if ("Duplicate" in result.Err && result.Err.Duplicate.canister_id[0]) {
    return result.Err.Duplicate.canister_id[0];
  }
  throw new Error(cyclesLedgerErrorMessage(result.Err));
}

type InstallMode = Parameters<ManagementService["install_code"]>[0]["mode"];

// Candid encoding of an empty argument tuple: `()`. A zero-byte blob only
// works for modules that export no canister_init function at all.
const EMPTY_CANDID_ARGS = new Uint8Array([68, 73, 68, 76, 0, 0]);

/** Installs small modules directly and routes larger modules through the
 * management canister's chunk store. Each chunk stays below the IC's 1 MiB
 * upload_chunk limit; install_chunked_code verifies the SHA-256 hash of the
 * reassembled module before installing it. */
async function installWasm(
  actor: ManagementService,
  canisterId: Principal,
  wasmModule: Uint8Array,
  mode: InstallMode,
): Promise<void> {
  if (wasmModule.byteLength <= DIRECT_INSTALL_LIMIT) {
    await actor.install_code({
      mode,
      canister_id: canisterId,
      wasm_module: wasmModule,
      arg: EMPTY_CANDID_ARGS,
      sender_canister_version: [],
    });
    return;
  }

  await actor.clear_chunk_store({ canister_id: canisterId });
  try {
    const chunkHashes: Array<{ hash: Uint8Array }> = [];
    for (let offset = 0; offset < wasmModule.byteLength; offset += WASM_CHUNK_SIZE) {
      const chunk = wasmModule.slice(offset, offset + WASM_CHUNK_SIZE);
      chunkHashes.push(await actor.upload_chunk({ canister_id: canisterId, chunk }));
    }

    const wasmModuleHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", wasmModule.slice().buffer),
    );
    await actor.install_chunked_code({
      mode,
      target_canister: canisterId,
      store_canister: [],
      chunk_hashes_list: chunkHashes,
      wasm_module_hash: wasmModuleHash,
      arg: EMPTY_CANDID_ARGS,
      sender_canister_version: [],
    });
  } finally {
    await actor.clear_chunk_store({ canister_id: canisterId }).catch(() => undefined);
  }
}

/** `None` if unset - mirrors `deploy.ts::orchestratorPrincipal`. */
function orchestratorPrincipal(): Principal | null {
  const text = runtimeValue("ORCHESTRATOR_PRINCIPAL");
  return text ? Principal.fromText(text) : null;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "runtime";
}

/** Creates a brand-new canister and installs `wasmModule` on it as this
 * project's runtime - the "upload/deploy wasm" half of the Runtime page.
 * `label` is a human name (e.g. the picked file's name minus `.wasm`); the
 * canister is recorded on the project as `runtime-<slug>-<id-suffix>`, the
 * same collision-avoidance scheme `deploy.ts` uses.
 *
 * Right after install, this best-effort-queries the freshly-installed
 * module's own self-declared `canister_metadata!` (see
 * `canisterMetadata.ts::getCanisterMetadata`) and records the resulting
 * `CanisterKind` on the project instead of always hardcoding `"other"` - an
 * uploaded Auth/Database/Storage-type module is classified as such immediately,
 * the same way a marketplace-installed one would be, so it shows up in
 * e.g. `listAuthCanisters` right away rather than sitting undifferentiated
 * under Runtime. A module that doesn't declare a type (or doesn't
 * implement `canister_metadata!` at all) still falls back to `"other"`,
 * unchanged from before this detection existed.
 *
 * Also returns `hasConfig` (see `DeployedRuntimeCanister`'s own doc
 * comment) so `Runtime.tsx` can skip its post-deploy redirect to the
 * Settings page for a module that wouldn't have anything to show there. */
export async function deployWasmRuntime(label: string, wasmModule: Uint8Array, network: string, projectId: string, userPrincipal: Principal): Promise<DeployedRuntimeCanister> {
  const orchestrator = orchestratorPrincipal();
  const controllers = orchestrator ? [userPrincipal, orchestrator] : [userPrincipal];
  const canisterId = await createCanisterWithCyclesLedger(network, controllers);
  const actor = await managementActor(network, canisterId);

  await installWasm(actor, canisterId, wasmModule, { install: null });

  const canisterIdText = canisterId.toText();
  const [kind, hasConfig] = await Promise.all([
    getCanisterMetadata(canisterIdText, network).then(canisterKindFromMetadata),
    hasModuleConfig(canisterIdText, network),
  ]);

  const name = `${RUNTIME_PREFIX}${slugify(label)}-${canisterIdText.slice(0, 5)}`;
  await addProjectCanisters(projectId, [[name, { id: canisterIdText, kind }]]);

  return { name, id: canisterIdText, kind, hasConfig };
}

/** Attaches an existing canister this project didn't deploy - a real
 * controller check, not a formality: `readPublicInfo`'s certificate-path
 * `read_state` query (same one every canister card's stats already use)
 * returns the canister's genuine current controller list, independent of
 * whatever identity actually created it, and this rejects outright unless
 * the signed-in user's own principal is in it. Unlike `deployWasmRuntime`,
 * this never adds the orchestrator as a controller itself - attaching
 * doesn't change who controls the canister at all, only what this project
 * tracks; if the orchestrator needs control too (e.g. so the Secretary can
 * later upgrade it), the user adds it themselves via the canister's own
 * Settings page, same as any other controller change.
 *
 * `label`, if given, becomes part of the tracked name; otherwise falls back
 * to a short id-derived one, same collision-avoidance scheme
 * `deployWasmRuntime` uses. Rejects if this exact canister id is already
 * tracked under this project, under any name - attaching it twice would
 * just create a second entry pointing at the same real canister. */
export async function attachRuntimeCanister(canisterIdText: string, label: string, network: string, project: Project, userPrincipal: Principal): Promise<DeployedRuntimeCanister> {
  let canisterId: Principal;
  try {
    canisterId = Principal.fromText(canisterIdText.trim());
  } catch {
    throw new Error(`"${canisterIdText}" is not a valid canister id`);
  }
  const normalizedId = canisterId.toText();

  if (Object.values(project.canisters).some((info) => info.id === normalizedId)) {
    throw new Error(`${normalizedId} is already tracked on this project`);
  }

  const { controllers } = await readPublicInfo(canisterId, network);
  if (!controllers.includes(userPrincipal.toText())) {
    throw new Error(
      controllers.length > 0
        ? `${userPrincipal.toText()} is not a controller of ${normalizedId} (current controllers: ${controllers.join(", ")})`
        : `couldn't confirm controllers for ${normalizedId} - it may not exist on this network, or the query failed`
    );
  }

  const [kind, hasConfig] = await Promise.all([
    getCanisterMetadata(normalizedId, network).then(canisterKindFromMetadata),
    hasModuleConfig(normalizedId, network),
  ]);

  const name = `${RUNTIME_PREFIX}${slugify(label || normalizedId.slice(0, 5))}-${normalizedId.slice(0, 5)}`;
  await addProjectCanisters(project.id, [[name, { id: normalizedId, kind }]]);

  return { name, id: normalizedId, kind, hasConfig };
}

export type UpdateMode = "upgrade" | "reinstall";

/** Installs new wasm bytes onto an *existing* canister, either as a real
 * `install_code` `upgrade` (state preserved, pre/post-upgrade hooks run -
 * not a fabricated no-op) or a `reinstall` (stable memory wiped, as if
 * freshly installed). Deliberately `reinstall`, never `install`, for the
 * wipe case: the IC's `install` mode requires the target to currently have
 * *no* wasm module at all and traps otherwise - `reinstall` is the mode
 * that means "wipe and install fresh" on a canister that already has
 * code. Nothing to update on `backend` itself either way: the canister's
 * id and project entry are unchanged, only its code (and, for `reinstall`,
 * its stable memory) is. */
export async function upgradeWasmRuntime(canisterId: string, wasmModule: Uint8Array, network: string, mode: UpdateMode = "upgrade"): Promise<void> {
  const targetCanisterId = Principal.fromText(canisterId);
  const actor = await managementActor(network, targetCanisterId);
  await installWasm(actor, targetCanisterId, wasmModule, mode === "reinstall" ? { reinstall: null } : { upgrade: [] });
}
