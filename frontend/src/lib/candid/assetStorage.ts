// Minimal capability surface copied from `packages/assetstorage.did`.
// Discovery deliberately probes two lightweight public queries instead of
// downloading the full asset list merely to identify a canister.

import { IDL } from "@icp-sdk/core/candid";

export interface AssetStorageStateInfo {
  last_state_update_timestamp: bigint;
  state_hash: [] | [string];
}

export interface AssetStorageProbeService {
  api_version: () => Promise<number>;
  get_state_info: () => Promise<AssetStorageStateInfo>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const StateInfo = IDL.Record({
    last_state_update_timestamp: IDL.Nat64,
    state_hash: IDL.Opt(IDL.Text),
  });
  return IDL.Service({
    api_version: IDL.Func([], [IDL.Nat16], ["query"]),
    get_state_info: IDL.Func([], [StateInfo], ["query"]),
  });
};
