// Hand-written mirror of `canister-hub-sdk`'s `ic::config` module (see
// `sdk/src/ic/config.rs`) - the standardized dynamic-config surface every
// `#[dynamic_config]` Marketplace Module canister exposes:
// `get_config_schema`/`get_config`/`set_config`, plus the webpages declared
// through `#[config_links(...)]` and returned by `get_links`.
// Not every deployed canister implements this - a canister that doesn't
// (older module, or one that never opted in) simply rejects these calls,
// which every caller in `lib/moduleConfig.ts` treats as "no config here",
// not an error to surface. A canister's own self-declared identity
// (name/description/type) is a separate, decoupled concern - see
// `candid/canisterMetadata.ts`, not this file.

import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

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
  /** Optional presentation metadata; absent on older module canisters. */
  group: [] | [string];
  group_label: [] | [string];
  group_description: [] | [string];
  field_type: ConfigType;
  /** Optional installed-canister filter for CanisterPicker fields. */
  canister_type: [] | [CanisterType];
  is_required: boolean;
  /** Optional for compatibility with canisters deployed before read-only
   * config fields were added. Missing means editable. */
  is_readonly: [] | [boolean];
  default_value: [] | [ConfigValue];
}

/** Same `ic::config::CanisterType` a `CanisterPicker` field's `canister_type`
 * filter uses (see `ConfigType` above) - re-exported here since this is its
 * Rust source of truth; `candid/canisterMetadata.ts` imports it from here
 * rather than redefining it. */
export type CanisterType = { Auth: null } | { Storage: null } | { Database: null } | { Custom: null };

export type LinkKind = { Admin: null } | { Public: null };

export interface CanisterLink {
  label: string;
  url: string;
  kind: LinkKind;
}

export interface ModuleConfigService {
  get_config_schema: () => Promise<ConfigFieldSchema[]>;
  get_config: () => Promise<Array<[string, ConfigValue]>>;
  set_config: (newSettings: Array<[string, ConfigValue]>) => Promise<{ Ok: null } | { Err: string }>;
  get_links: () => Promise<CanisterLink[]>;
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
    is_required: IDL.Bool,
    is_readonly: IDL.Opt(IDL.Bool),
    default_value: IDL.Opt(ConfigValue),
  });
  const ConfigMap = IDL.Vec(IDL.Tuple(IDL.Text, ConfigValue));
  const SetConfigResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const LinkKind = IDL.Variant({ Admin: IDL.Null, Public: IDL.Null });
  const CanisterLink = IDL.Record({ label: IDL.Text, url: IDL.Text, kind: LinkKind });
  return IDL.Service({
    get_config_schema: IDL.Func([], [IDL.Vec(ConfigFieldSchema)], ["query"]),
    get_config: IDL.Func([], [ConfigMap], ["query"]),
    set_config: IDL.Func([ConfigMap], [SetConfigResult], []),
    get_links: IDL.Func([], [IDL.Vec(CanisterLink)], ["query"]),
  });
};
