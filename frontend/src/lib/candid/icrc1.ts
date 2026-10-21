// Hand-written mirror of the real ICRC-1 fungible-token standard, plus the
// real ICRC-2 `approve` extension - the same interface the real ICP Ledger
// and the real Cycles Ledger both implement (see `lib/wallet.ts`), and
// what any user-tracked custom token is expected to implement too. Verified
// directly against the real candid (dfinity/ic's own `ledger.did`), not
// guessed - in particular `Account.subaccount`/`TransferArg.from_subaccount`/
// `ApproveArgs.from_subaccount` are all `opt blob` (a raw 32-byte
// subaccount), and every "amount"-shaped field (`amount`/`fee`/
// `expected_allowance`) is a plain `nat`, not a fixed-width int.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export interface Account {
  owner: Principal;
  subaccount: [] | [Uint8Array];
}

export interface TransferArg {
  from_subaccount: [] | [Uint8Array];
  to: Account;
  amount: bigint;
  fee: [] | [bigint];
  memo: [] | [Uint8Array];
  created_at_time: [] | [bigint];
}

export type TransferError =
  | { BadFee: { expected_fee: bigint } }
  | { BadBurn: { min_burn_amount: bigint } }
  | { InsufficientFunds: { balance: bigint } }
  | { TooOld: null }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint } }
  | { GenericError: { error_code: bigint; message: string } };

export interface ApproveArgs {
  from_subaccount: [] | [Uint8Array];
  spender: Account;
  amount: bigint;
  expected_allowance: [] | [bigint];
  expires_at: [] | [bigint];
  fee: [] | [bigint];
  memo: [] | [Uint8Array];
  created_at_time: [] | [bigint];
}

export type ApproveError =
  | { BadFee: { expected_fee: bigint } }
  | { InsufficientFunds: { balance: bigint } }
  | { AllowanceChanged: { current_allowance: bigint } }
  | { Expired: { ledger_time: bigint } }
  | { TooOld: null }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint } }
  | { GenericError: { error_code: bigint; message: string } };

export interface Icrc1Service {
  icrc1_balance_of: (account: Account) => Promise<bigint>;
  icrc1_symbol: () => Promise<string>;
  icrc1_decimals: () => Promise<number>;
  icrc1_name: () => Promise<string>;
  /** Not part of the core ICRC-1 standard, but a real method both the ICP
   * Ledger and the Cycles Ledger implement (verified directly) - used only
   * to *display* the real fee before sending; the transfer/approve calls
   * below always pass `fee: []` themselves so the ledger applies its own
   * current fee, rather than this frontend risking a stale `BadFee`
   * rejection from a value it cached. */
  icrc1_fee: () => Promise<bigint>;
  icrc1_transfer: (args: TransferArg) => Promise<{ Ok: bigint } | { Err: TransferError }>;
  icrc2_approve: (args: ApproveArgs) => Promise<{ Ok: bigint } | { Err: ApproveError }>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });

  const TransferArg = IDL.Record({
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    to: Account,
    amount: IDL.Nat,
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
  });
  const TransferError = IDL.Variant({
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
  });
  const TransferResult = IDL.Variant({ Ok: IDL.Nat, Err: TransferError });

  const ApproveArgs = IDL.Record({
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    spender: Account,
    amount: IDL.Nat,
    expected_allowance: IDL.Opt(IDL.Nat),
    expires_at: IDL.Opt(IDL.Nat64),
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
  });
  const ApproveError = IDL.Variant({
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
    AllowanceChanged: IDL.Record({ current_allowance: IDL.Nat }),
    Expired: IDL.Record({ ledger_time: IDL.Nat64 }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
  });
  const ApproveResult = IDL.Variant({ Ok: IDL.Nat, Err: ApproveError });

  return IDL.Service({
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ["query"]),
    icrc1_symbol: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
    icrc1_name: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_transfer: IDL.Func([TransferArg], [TransferResult], []),
    icrc2_approve: IDL.Func([ApproveArgs], [ApproveResult], []),
  });
};
