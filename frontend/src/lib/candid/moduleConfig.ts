// Hand-written mirror of `canister-hub-sdk`'s `ic::config` module (see
// `sdk/src/ic/config.rs`) - the standardized dynamic-config surface every
// `#[dynamic_config]` Marketplace Module canister exposes:
// `get_config_schema`/`get_config`/`set_config`, plus the optional
// `#[config_urls(...)]`-driven `get_admin_panel_url`/`get_home_page_url`.
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
  | { PrincipalId: Principal };

export type ConfigType =
  | { Text: null }
  | { Number: null }
  | { Float: null }
  | { Boolean: null }
  | { Select: { options: string[] } }
  | { CanisterPicker: { module_type_filter: [] | [string] } }
  | { SecretText: null };

export interface ConfigFieldSchema {
  key: string;
  label: string;
  description: string;
  field_type: ConfigType;
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

export interface ModuleConfigService {
  get_config_schema: () => Promise<ConfigFieldSchema[]>;
  get_config: () => Promise<Array<[string, ConfigValue]>>;
  set_config: (newSettings: Array<[string, ConfigValue]>) => Promise<{ Ok: null } | { Err: string }>;
  get_admin_panel_url: () => Promise<[] | [string]>;
  get_home_page_url: () => Promise<[] | [string]>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const ConfigValue = IDL.Variant({
    Text: IDL.Text,
    Number: IDL.Int64,
    Float: IDL.Float64,
    Boolean: IDL.Bool,
    PrincipalId: IDL.Principal,
  });
  const ConfigType = IDL.Variant({
    Text: IDL.Null,
    Number: IDL.Null,
    Float: IDL.Null,
    Boolean: IDL.Null,
    Select: IDL.Record({ options: IDL.Vec(IDL.Text) }),
    CanisterPicker: IDL.Record({ module_type_filter: IDL.Opt(IDL.Text) }),
    SecretText: IDL.Null,
  });
  const ConfigFieldSchema = IDL.Record({
    key: IDL.Text,
    label: IDL.Text,
    description: IDL.Text,
    field_type: ConfigType,
    is_required: IDL.Bool,
    is_readonly: IDL.Opt(IDL.Bool),
    default_value: IDL.Opt(ConfigValue),
  });
  const ConfigMap = IDL.Vec(IDL.Tuple(IDL.Text, ConfigValue));
  const SetConfigResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return IDL.Service({
    get_config_schema: IDL.Func([], [IDL.Vec(ConfigFieldSchema)], ["query"]),
    get_config: IDL.Func([], [ConfigMap], ["query"]),
    set_config: IDL.Func([ConfigMap], [SetConfigResult], []),
    get_admin_panel_url: IDL.Func([], [IDL.Opt(IDL.Text)], ["query"]),
    get_home_page_url: IDL.Func([], [IDL.Opt(IDL.Text)], ["query"]),
  });
};
