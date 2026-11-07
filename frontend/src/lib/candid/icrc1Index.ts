// Hand-written interface for the ICRC-1 index canister's
// `get_account_transactions`, used by the Wallet page's Top-Up History to
// list cycles mints credited to the signed-in principal's default Cycles
// Ledger account. Declared to match the interface served by the live
// cycles-ledger index canister (`icrc106_get_index_principal` on the
// Cycles Ledger points at it), verified via its `candid:service` metadata
// - argument and result types match exactly, because the index traps on
// candid subtyping mismatches (e.g. an nat64 argument where it declares
// `nat`).
//
// Only the fields the UI reads are declared - candid record decoding
// ignores undeclared fields, so index versions that add more (fee
// collector, authorized mints, …) stay compatible.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export interface IcrcIndexAccount {
  owner: Principal;
  subaccount: [] | [Uint8Array];
}

export interface IcrcIndexTransactionWithId {
  id: bigint;
  transaction: {
    /** "mint", "transfer", "burn" or "approve". */
    kind: string;
    /** Present on mints (the CMC's `notify_mint_cycles` deposit, or a
     * cycles `deposit`) - exactly the top-ups Top-Up History lists. */
    mint: [] | [{ to: IcrcIndexAccount; amount: bigint }];
    /** Nanoseconds since the epoch. */
    timestamp: bigint;
  };
}

export interface IcrcIndexGetTransactions {
  balance: bigint;
  transactions: IcrcIndexTransactionWithId[];
  oldest_tx_id: [] | [bigint];
}

export type IcrcIndexTransactionsResult =
  | { Ok: IcrcIndexGetTransactions }
  | { Err: { message: string } };

export interface Icrc1IndexService {
  get_account_transactions: (args: {
    account: IcrcIndexAccount;
    /** Exclusive cursor: results start at the txid after this one;
     * absent starts at the most recent txid. */
    start: [] | [bigint];
    max_results: bigint;
  }) => Promise<IcrcIndexTransactionsResult>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  const Transaction = IDL.Record({
    kind: IDL.Text,
    mint: IDL.Opt(IDL.Record({ to: Account, amount: IDL.Nat })),
    timestamp: IDL.Nat64,
  });
  const GetTransactions = IDL.Record({
    balance: IDL.Nat,
    transactions: IDL.Vec(IDL.Record({ id: IDL.Nat, transaction: Transaction })),
    oldest_tx_id: IDL.Opt(IDL.Nat),
  });
  return IDL.Service({
    get_account_transactions: IDL.Func(
      [IDL.Record({ account: Account, start: IDL.Opt(IDL.Nat), max_results: IDL.Nat })],
      [IDL.Variant({ Ok: GetTransactions, Err: IDL.Record({ message: IDL.Text }) })],
      ["query"],
    ),
  });
};
