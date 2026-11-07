// Hand-written mirror of the embedding payment canister's interface
// (`packages/kora-payment` - the canonical implementation of the shared
// Payment Provider API in `packages/payment_api.did`), plus the
// standardized dynamic-config surface every module exposes
// (`canister-hub-sdk`'s `ic::config`, mirrored for the dashboard in
// `frontend/src/lib/candid/moduleConfig.ts` - the config half of this
// file's IDL is copied from there verbatim so both stay interchangeable).

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

// ---------------------------------------------------------------------------
// Dynamic config (`canister-hub-sdk::ic::config`)
// ---------------------------------------------------------------------------

export type ConfigValue =
  | { Text: string }
  | { Number: bigint }
  | { Float: number }
  | { Boolean: boolean }
  | { PrincipalId: Principal }
  | { Vector: ConfigVectorValue[] };

export type ConfigVectorValue =
  | { Text: string }
  | { Number: bigint }
  | { Float: number }
  | { Boolean: boolean }
  | { PrincipalId: Principal };

export type ConfigVectorType =
  | { Text: null }
  | { Number: null }
  | { Float: null }
  | { Boolean: null }
  | { Select: { options: string[] } }
  | { CanisterPicker: { module_type_filter: [] | [string] } }
  | { SecretText: null };

export type ConfigType =
  | { Text: null }
  | { TextArea: null }
  | { Number: null }
  | { Float: null }
  | { Boolean: null }
  | { Select: { options: string[] } }
  | { CanisterPicker: { module_type_filter: [] | [string] } }
  | { SecretText: null }
  | { Vector: { element_type: ConfigVectorType } };

export interface ConfigFieldSchema {
  key: string;
  label: string;
  description: string;
  group: [] | [string];
  group_label: [] | [string];
  group_description: [] | [string];
  field_type: ConfigType;
  canister_type: [] | [CanisterType];
  package_name: [] | [string];
  is_required: boolean;
  is_readonly: [] | [boolean];
  default_value: [] | [ConfigValue];
}

export type CanisterType = { Auth: null } | { Storage: null } | { Database: null } | { Custom: null };

export type LinkKind = { Admin: null } | { Public: null };

export interface CanisterLink {
  label: string;
  url: string;
  kind: LinkKind;
}

// ---------------------------------------------------------------------------
// Payment module (`packages/kora-payment`)
// ---------------------------------------------------------------------------

/** One row of the canister's transaction log - see
 * `packages/kora-payment/src/lib.rs::Transaction`. Amounts stay in minor
 * units on the wire; `lib/format.ts` renders them. */
export interface Transaction {
  reference: string;
  merchant_reference: string;
  order_id: bigint;
  amount_minor: bigint;
  currency: string;
  checkout_url: string;
  status: string;
  transaction_id: string;
  /** Nanoseconds since the Unix epoch. */
  created_at: bigint;
  owner_notified: boolean;
}

export interface CanisterMetadata {
  name: string;
  description: string;
  version: string;
  canister_type: [] | [CanisterType];
}

export interface PaymentService {
  canister_metadata: () => Promise<CanisterMetadata>;
  get_config_schema: () => Promise<ConfigFieldSchema[]>;
  get_config: () => Promise<Array<[string, ConfigValue]>>;
  set_config: (newSettings: Array<[string, ConfigValue]>) => Promise<{ Ok: null } | { Err: string }>;
  get_links: () => Promise<CanisterLink[]>;
  list_transactions: () => Promise<{ Ok: Transaction[] } | { Err: string }>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const ConfigVectorValue = IDL.Variant({
    Text: IDL.Text,
    Number: IDL.Int64,
    Float: IDL.Float64,
    Boolean: IDL.Bool,
    PrincipalId: IDL.Principal,
  });
  const ConfigVectorType = IDL.Variant({
    Text: IDL.Null,
    Number: IDL.Null,
    Float: IDL.Null,
    Boolean: IDL.Null,
    Select: IDL.Record({ options: IDL.Vec(IDL.Text) }),
    CanisterPicker: IDL.Record({ module_type_filter: IDL.Opt(IDL.Text) }),
    SecretText: IDL.Null,
  });
  const ConfigValue = IDL.Variant({
    Text: IDL.Text,
    Number: IDL.Int64,
    Float: IDL.Float64,
    Boolean: IDL.Bool,
    PrincipalId: IDL.Principal,
    Vector: IDL.Vec(ConfigVectorValue),
  });
  const ConfigType = IDL.Variant({
    Text: IDL.Null,
    TextArea: IDL.Null,
    Number: IDL.Null,
    Float: IDL.Null,
    Boolean: IDL.Null,
    Select: IDL.Record({ options: IDL.Vec(IDL.Text) }),
    CanisterPicker: IDL.Record({ module_type_filter: IDL.Opt(IDL.Text) }),
    SecretText: IDL.Null,
    Vector: IDL.Record({ element_type: ConfigVectorType }),
  });
  const CanisterType = IDL.Variant({
    Auth: IDL.Null,
    Storage: IDL.Null,
    Database: IDL.Null,
    Custom: IDL.Null,
  });
  const ConfigFieldSchema = IDL.Record({
    key: IDL.Text,
    label: IDL.Text,
    description: IDL.Text,
    group: IDL.Opt(IDL.Text),
    group_label: IDL.Opt(IDL.Text),
    group_description: IDL.Opt(IDL.Text),
    field_type: ConfigType,
    canister_type: IDL.Opt(CanisterType),
    package_name: IDL.Opt(IDL.Text),
    is_required: IDL.Bool,
    is_readonly: IDL.Opt(IDL.Bool),
    default_value: IDL.Opt(ConfigValue),
  });
  const ConfigMap = IDL.Vec(IDL.Tuple(IDL.Text, ConfigValue));
  const SetConfigResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const LinkKind = IDL.Variant({ Admin: IDL.Null, Public: IDL.Null });
  const CanisterLink = IDL.Record({ label: IDL.Text, url: IDL.Text, kind: LinkKind });
  const CanisterMetadata = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    version: IDL.Text,
    canister_type: IDL.Opt(CanisterType),
  });
  const Transaction = IDL.Record({
    reference: IDL.Text,
    merchant_reference: IDL.Text,
    order_id: IDL.Nat64,
    amount_minor: IDL.Nat64,
    currency: IDL.Text,
    checkout_url: IDL.Text,
    status: IDL.Text,
    transaction_id: IDL.Text,
    created_at: IDL.Nat64,
    owner_notified: IDL.Bool,
  });
  const ListTransactionsResult = IDL.Variant({ Ok: IDL.Vec(Transaction), Err: IDL.Text });

  return IDL.Service({
    canister_metadata: IDL.Func([], [CanisterMetadata], ["query"]),
    get_config_schema: IDL.Func([], [IDL.Vec(ConfigFieldSchema)], ["query"]),
    get_config: IDL.Func([], [ConfigMap], ["query"]),
    set_config: IDL.Func([ConfigMap], [SetConfigResult], []),
    get_links: IDL.Func([], [IDL.Vec(CanisterLink)], ["query"]),
    list_transactions: IDL.Func([], [ListTransactionsResult], ["query"]),
  });
};
