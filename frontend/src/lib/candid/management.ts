// Hand-written mirror of a handful of the IC management canister's real
// methods (`aaaaa-aa` - the well-known, always-present management canister
// id, not deployed source of our own): `canister_status` (read-only stats)
// plus the real lifecycle operations a canister's own controller can
// perform on it directly - `stop_canister`/`start_canister`/
// `delete_canister` (see `lib/canisterOps.ts`). All of these are
// controller-only: they succeed when the calling identity is a controller
// of the target, which is now genuinely true for the real signed-in user on
// every canister the orchestrator deploys for them (`process::add_controller`
// adds them as a controller right after deploy - see
// `per-user-canister-ownership` project notes), not just on this project's
// own local dev network. `module_hash`/`controllers` have a separate,
// always-available path with no controller requirement at all - see
// `readCanisterPublicInfo` in `lib/canisterStats.ts`, which every canister
// can use regardless of this module's own success or failure.
//
// Verified directly against this project's own local icp-cli-managed
// network (`node` + `@icp-sdk/core`, same call shape this file's own
// callers use): every one of these methods fails there with a real HTTP
// 400 `canister_not_found` - the *gateway* itself rejects any `/call`
// request naming `aaaaa-aa` as the target canister before the request ever
// reaches the IC, the exact same quirk `readControllerOnlyInfo` in
// `lib/canisterStats.ts` already documented for `canister_status` alone -
// this confirms it's general to the management canister id on this
// gateway, not specific to that one method. Confirmed harmless to test
// this way: the rejection happens before anything is touched, so a failed
// `stop_canister` call here never actually stops the target. Expected to
// work normally against real IC mainnet, where `aaaaa-aa` is a properly
// routable target - this is a disclosed local-gateway-only limitation, not
// a flaw in these calls themselves.

import { IDL } from "@icp-sdk/core/candid";

export const MANAGEMENT_CANISTER_ID = "aaaaa-aa";

export type CanisterStatusVariant = { running: null } | { stopping: null } | { stopped: null };

export interface CanisterStatusResult {
  status: CanisterStatusVariant;
  memory_size: bigint;
  cycles: bigint;
  /** The real IC's own burn-rate figure - cycles this canister would burn
   * per day from idle compute/memory allocation alone if it received no
   * further calls. The one real, per-canister source `lib/canisterStats.ts`
   * sums across a project to report an actual "Burn Rate", replacing what
   * used to be a hardcoded mock number. */
  idle_cycles_burned_per_day: bigint;
  module_hash: [] | [Uint8Array];
  settings: { controllers: Array<import("@icp-sdk/core/principal").Principal>; freezing_threshold: bigint };
}

/** Every field is genuinely `opt` on the real IC management canister -
 * `lib/deploy.ts` only ever sets `controllers`, leaving everything else
 * (compute/memory allocation, log visibility, etc.) at the IC's own
 * defaults. Verified against the real interface spec
 * (docs.internetcomputer.org/references/ic-interface-spec/management-canister)
 * at implementation time, not hand-guessed. */
export interface CanisterSettingsArg {
  controllers: [] | [Array<import("@icp-sdk/core/principal").Principal>];
}

export interface ManagementService {
  canister_status: (args: { canister_id: import("@icp-sdk/core/principal").Principal }) => Promise<CanisterStatusResult>;
  /** Rejects if the target has any running call in flight until they
   * drain - the real IC semantics, not something this frontend needs to
   * poll for itself (the call simply doesn't resolve until stopped). */
  stop_canister: (args: { canister_id: import("@icp-sdk/core/principal").Principal }) => Promise<void>;
  start_canister: (args: { canister_id: import("@icp-sdk/core/principal").Principal }) => Promise<void>;
  /** Irreversible - the real IC rejects this outright unless the target is
   * already `Stopped` (see `canisterOps.ts::deleteCanister`, which stops it
   * first). */
  delete_canister: (args: { canister_id: import("@icp-sdk/core/principal").Principal }) => Promise<void>;
  /** Direct management-canister creation. Browser runtime uploads use the
   * Cycles Ledger instead (see `lib/runtime.ts`); this method remains for
   * older callers that have their own cycle-bearing creation mechanism. */
  create_canister: (args: { settings: [] | [CanisterSettingsArg]; sender_canister_version: [] | [bigint] }) => Promise<{ canister_id: import("@icp-sdk/core/principal").Principal }>;
  /** Local/test replicas only - grants free cycles with no funding source
   * needed, which is what makes local canister creation possible at all
   * from a bare Internet Identity principal. */
  provisional_create_canister_with_cycles: (args: {
    amount: [] | [bigint];
    settings: [] | [CanisterSettingsArg];
    specified_id: [] | [import("@icp-sdk/core/principal").Principal];
    sender_canister_version: [] | [bigint];
  }) => Promise<{ canister_id: import("@icp-sdk/core/principal").Principal }>;
  install_code: (args: {
    mode: { install: null } | { reinstall: null } | { upgrade: [] | [{ skip_pre_upgrade: [] | [boolean]; wasm_memory_persistence: [] | [{ keep: null } | { replace: null }] }] };
    canister_id: import("@icp-sdk/core/principal").Principal;
    wasm_module: Uint8Array;
    arg: Uint8Array;
    sender_canister_version: [] | [bigint];
  }) => Promise<void>;
  upload_chunk: (args: {
    canister_id: import("@icp-sdk/core/principal").Principal;
    chunk: Uint8Array;
  }) => Promise<{ hash: Uint8Array }>;
  clear_chunk_store: (args: {
    canister_id: import("@icp-sdk/core/principal").Principal;
  }) => Promise<void>;
  install_chunked_code: (args: {
    mode: { install: null } | { reinstall: null } | { upgrade: [] | [{ skip_pre_upgrade: [] | [boolean]; wasm_memory_persistence: [] | [{ keep: null } | { replace: null }] }] };
    target_canister: import("@icp-sdk/core/principal").Principal;
    store_canister: [] | [import("@icp-sdk/core/principal").Principal];
    chunk_hashes_list: Array<{ hash: Uint8Array }>;
    wasm_module_hash: Uint8Array;
    arg: Uint8Array;
    sender_canister_version: [] | [bigint];
  }) => Promise<void>;
  update_settings: (args: { canister_id: import("@icp-sdk/core/principal").Principal; settings: CanisterSettingsArg; sender_canister_version: [] | [bigint] }) => Promise<void>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Status = IDL.Variant({ running: IDL.Null, stopping: IDL.Null, stopped: IDL.Null });
  const Settings = IDL.Record({ controllers: IDL.Vec(IDL.Principal), freezing_threshold: IDL.Nat });
  const CanisterStatusResult = IDL.Record({
    status: Status,
    memory_size: IDL.Nat,
    cycles: IDL.Nat,
    idle_cycles_burned_per_day: IDL.Nat,
    module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    settings: Settings,
  });
  const CanisterIdArg = IDL.Record({ canister_id: IDL.Principal });

  // Every field genuinely `opt` on the real IC type - only `controllers` is
  // ever actually set by this codebase (see `CanisterSettingsArg` above).
  const CanisterSettings = IDL.Record({ controllers: IDL.Opt(IDL.Vec(IDL.Principal)) });
  const CreateCanisterArgs = IDL.Record({ settings: IDL.Opt(CanisterSettings), sender_canister_version: IDL.Opt(IDL.Nat64) });
  const CreateCanisterResult = IDL.Record({ canister_id: IDL.Principal });
  const ProvisionalCreateCanisterArgs = IDL.Record({
    amount: IDL.Opt(IDL.Nat),
    settings: IDL.Opt(CanisterSettings),
    specified_id: IDL.Opt(IDL.Principal),
    sender_canister_version: IDL.Opt(IDL.Nat64),
  });
  const CanisterInstallMode = IDL.Variant({
    install: IDL.Null,
    reinstall: IDL.Null,
    upgrade: IDL.Opt(IDL.Record({ skip_pre_upgrade: IDL.Opt(IDL.Bool), wasm_memory_persistence: IDL.Opt(IDL.Variant({ keep: IDL.Null, replace: IDL.Null })) })),
  });
  const InstallCodeArgs = IDL.Record({
    mode: CanisterInstallMode,
    canister_id: IDL.Principal,
    wasm_module: IDL.Vec(IDL.Nat8),
    arg: IDL.Vec(IDL.Nat8),
    sender_canister_version: IDL.Opt(IDL.Nat64),
  });
  const ChunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
  const UploadChunkArgs = IDL.Record({
    canister_id: IDL.Principal,
    chunk: IDL.Vec(IDL.Nat8),
  });
  const InstallChunkedCodeArgs = IDL.Record({
    mode: CanisterInstallMode,
    target_canister: IDL.Principal,
    store_canister: IDL.Opt(IDL.Principal),
    chunk_hashes_list: IDL.Vec(ChunkHash),
    wasm_module_hash: IDL.Vec(IDL.Nat8),
    arg: IDL.Vec(IDL.Nat8),
    sender_canister_version: IDL.Opt(IDL.Nat64),
  });
  const UpdateSettingsArgs = IDL.Record({ canister_id: IDL.Principal, settings: CanisterSettings, sender_canister_version: IDL.Opt(IDL.Nat64) });

  return IDL.Service({
    canister_status: IDL.Func([CanisterIdArg], [CanisterStatusResult], []),
    stop_canister: IDL.Func([CanisterIdArg], [], []),
    start_canister: IDL.Func([CanisterIdArg], [], []),
    delete_canister: IDL.Func([CanisterIdArg], [], []),
    create_canister: IDL.Func([CreateCanisterArgs], [CreateCanisterResult], []),
    provisional_create_canister_with_cycles: IDL.Func([ProvisionalCreateCanisterArgs], [CreateCanisterResult], []),
    install_code: IDL.Func([InstallCodeArgs], [], []),
    upload_chunk: IDL.Func([UploadChunkArgs], [ChunkHash], []),
    clear_chunk_store: IDL.Func([CanisterIdArg], [], []),
    install_chunked_code: IDL.Func([InstallChunkedCodeArgs], [], []),
    update_settings: IDL.Func([UpdateSettingsArgs], [], []),
  });
};
