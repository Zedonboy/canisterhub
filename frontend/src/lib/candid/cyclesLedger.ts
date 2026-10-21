import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export const CYCLES_LEDGER_CANISTER_ID = "um5iw-rqaaa-aaaaq-qaaba-cai";

export interface CyclesLedgerCanisterSettings {
  controllers: [] | [Principal[]];
  compute_allocation: [] | [bigint];
  memory_allocation: [] | [bigint];
  freezing_threshold: [] | [bigint];
  reserved_cycles_limit: [] | [bigint];
}

export interface CyclesLedgerCreateCanisterArgs {
  from_subaccount: [] | [Uint8Array];
  created_at_time: [] | [bigint];
  amount: bigint;
  creation_args: [] | [{
    settings: [] | [CyclesLedgerCanisterSettings];
    subnet_selection: [] | [
      | { Subnet: { subnet: Principal } }
      | { Filter: { subnet_type: [] | [string] } }
    ];
  }];
}

export type CyclesLedgerCreateCanisterError =
  | { GenericError: { message: string; error_code: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint; canister_id: [] | [Principal] } }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { FailedToCreate: { error: string; refund_block: [] | [bigint]; fee_block: [] | [bigint] } }
  | { TooOld: null }
  | { InsufficientFunds: { balance: bigint } };

export type CyclesLedgerCreateCanisterResult =
  | { Ok: { block_id: bigint; canister_id: Principal } }
  | { Err: CyclesLedgerCreateCanisterError };

/** Real `withdraw` - moves cycles straight from the caller's own Cycles
 * Ledger (ICRC-1) balance into an *existing* canister's own cycles balance
 * (a real `deposit_cycles` performed by the ledger canister itself, not a
 * transfer to another ICRC-1 account) - the real "top up this canister"
 * primitive `create_canister` above doesn't cover, since that one only
 * ever funds a brand-new canister. Verified against the real Cycles Ledger
 * interface spec (github.com/dfinity/cycles-ledger's `cycles-ledger.did`)
 * at implementation time. */
export interface CyclesLedgerWithdrawArgs {
  to: Principal;
  from_subaccount: [] | [Uint8Array];
  created_at_time: [] | [bigint];
  amount: bigint;
}

export type RejectionCode =
  | { NoError: null }
  | { SysFatal: null }
  | { SysTransient: null }
  | { DestinationInvalid: null }
  | { CanisterReject: null }
  | { CanisterError: null }
  | { Unknown: null };

export type CyclesLedgerWithdrawError =
  | { FailedToWithdraw: { fee_block: [] | [bigint]; rejection_code: RejectionCode; rejection_reason: string } }
  | { GenericError: { message: string; error_code: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint } }
  | { BadFee: { expected_fee: bigint } }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TooOld: null }
  | { InsufficientFunds: { balance: bigint } };

export type CyclesLedgerWithdrawResult =
  | { Ok: bigint }
  | { Err: CyclesLedgerWithdrawError };

export interface CyclesLedgerService {
  create_canister: (args: CyclesLedgerCreateCanisterArgs) => Promise<CyclesLedgerCreateCanisterResult>;
  withdraw: (args: CyclesLedgerWithdrawArgs) => Promise<CyclesLedgerWithdrawResult>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const SubnetSelection = IDL.Variant({
    Filter: IDL.Record({ subnet_type: IDL.Opt(IDL.Text) }),
    Subnet: IDL.Record({ subnet: IDL.Principal }),
  });
  const CanisterSettings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
  });
  const CreateCanisterArgs = IDL.Record({
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
    amount: IDL.Nat,
    creation_args: IDL.Opt(IDL.Record({
      settings: IDL.Opt(CanisterSettings),
      subnet_selection: IDL.Opt(SubnetSelection),
    })),
  });
  const CreateCanisterSuccess = IDL.Record({
    block_id: IDL.Nat,
    canister_id: IDL.Principal,
  });
  const CreateCanisterError = IDL.Variant({
    GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat, canister_id: IDL.Opt(IDL.Principal) }),
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    FailedToCreate: IDL.Record({
      error: IDL.Text,
      refund_block: IDL.Opt(IDL.Nat),
      fee_block: IDL.Opt(IDL.Nat),
    }),
    TooOld: IDL.Null,
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  });

  const RejectionCode = IDL.Variant({
    NoError: IDL.Null,
    SysFatal: IDL.Null,
    SysTransient: IDL.Null,
    DestinationInvalid: IDL.Null,
    CanisterReject: IDL.Null,
    CanisterError: IDL.Null,
    Unknown: IDL.Null,
  });
  const WithdrawArgs = IDL.Record({
    to: IDL.Principal,
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
    amount: IDL.Nat,
  });
  const WithdrawError = IDL.Variant({
    FailedToWithdraw: IDL.Record({
      fee_block: IDL.Opt(IDL.Nat),
      rejection_code: RejectionCode,
      rejection_reason: IDL.Text,
    }),
    GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TooOld: IDL.Null,
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  });

  return IDL.Service({
    create_canister: IDL.Func(
      [CreateCanisterArgs],
      [IDL.Variant({ Ok: CreateCanisterSuccess, Err: CreateCanisterError })],
      [],
    ),
    withdraw: IDL.Func(
      [WithdrawArgs],
      [IDL.Variant({ Ok: IDL.Nat, Err: WithdrawError })],
      [],
    ),
  });
};
