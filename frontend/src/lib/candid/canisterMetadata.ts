// Hand-written mirror of `canister-hub-sdk`'s `ic::metadata` module (see
// `sdk/src/ic/metadata.rs`) - the `canister_metadata!` macro's one
// generated query, `canister_metadata() -> CanisterMetadata`. Deliberately
// its own file, not folded into `candid/moduleConfig.ts`: this is an
// independent, decoupled candid surface (a canister needs no
// `#[dynamic_config]` struct, or any stable storage, to expose it) backed
// entirely by compile-time constants - no `get_config_schema`-style
// discovery, no masking, nothing mutable. Not every deployed canister
// implements this - a canister that doesn't (older module, one that never
// opted in, or any other kind of canister entirely) simply rejects the
// call, which every caller in `lib/canisterMetadata.ts` treats as "no
// metadata here", not an error to surface.

import { IDL } from "@icp-sdk/core/candid";
import type { CanisterType } from "./moduleConfig";

export type { CanisterType };

export interface CanisterMetadata {
  name: string;
  description: string;
  canister_type: [] | [CanisterType];
  version: string;
}

export interface CanisterMetadataService {
  canister_metadata: () => Promise<CanisterMetadata>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const CanisterType = IDL.Variant({ Auth: IDL.Null, Storage: IDL.Null, Database: IDL.Null, Custom: IDL.Null });
  const CanisterMetadata = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    canister_type: IDL.Opt(CanisterType),
    version: IDL.Text,
  });
  return IDL.Service({
    canister_metadata: IDL.Func([], [CanisterMetadata], ["query"]),
  });
};
