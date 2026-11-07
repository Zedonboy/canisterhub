// Renders a `ConfigFieldSchema[]` (from a `#[dynamic_config]` Marketplace
// Module's `get_config_schema`) as editable settings on the left and
// canister-owned read-only data on the right. Field order follows the
// schema's own `Vec` order, not alphabetical - a module author's declared
// field order is the intended reading order.

import { useEffect, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { ChevronDown, PackagePlus } from "lucide-react";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Combobox } from "@/components/ui/Combobox";
import { InstallCanisterDialog } from "@/components/InstallCanisterDialog";
import type { DeployedCanister } from "@/lib/deploy";
import type { ConfigFieldSchema, ConfigType, ConfigValue, ConfigVectorType, ConfigVectorValue } from "@/lib/moduleConfig";

/** What each field edits as - a plain string for every text-like/numeric
 * field (kept as text while editing, parsed only on submit, so a half-typed
 * number never gets silently coerced mid-keystroke) or a real boolean for
 * `Boolean`. */
type RawScalarValue = string | boolean;
type RawValue = RawScalarValue | RawScalarValue[];
type ScalarType = ConfigVectorType | Exclude<ConfigType, { Vector: unknown }>;
type InstalledCanisters = Record<string, { id: string; kind: string; packageName?: string | null }>;

interface CanisterOption {
  name: string;
  id: string;
  kind: string;
  packageName?: string | null;
}

/** What `get_config` returns for a stored `SecretText` - the canister
 * masks secrets for every caller (write-only "secret egress" rule), so
 * this is all any settings UI ever holds. An untouched masked field must
 * never be submitted back: `set_config` rejects the literal as a guard
 * against round-tripping it over the real secret. */
const MASKED_SECRET = "••••••••";

function isSecretType(fieldType: ConfigType | ConfigVectorType): boolean {
  return "SecretText" in fieldType;
}

function isTextLike(fieldType: ScalarType): boolean {
  return "Text" in fieldType || "TextArea" in fieldType || "SecretText" in fieldType || "Select" in fieldType;
}

function configValueToRaw(fieldType: ConfigType, value: ConfigValue | undefined): RawValue {
  if ("Vector" in fieldType) {
    if (!value || !("Vector" in value)) return [];
    return value.Vector.map(vectorValueToRaw);
  }
  return scalarConfigValueToRaw(fieldType, value);
}

function scalarConfigValueToRaw(fieldType: ScalarType, value: ConfigValue | undefined): RawScalarValue {
  if ("Boolean" in fieldType) return value && "Boolean" in value ? value.Boolean : false;
  if (!value) return "";
  if ("Text" in value) return value.Text;
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  return "";
}

function vectorValueToRaw(value: ConfigVectorValue): RawScalarValue {
  if ("Text" in value) return value.Text;
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("Boolean" in value) return value.Boolean;
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  return "";
}

/** `null` return means "couldn't convert" - the caller turns that into an
 * inline field error rather than silently dropping or guessing a value. */
function resolveCanisterId(raw: RawScalarValue, installedCanisters: InstalledCanisters): string {
  const candidate = String(raw).trim();
  const namedCanister = Object.entries(installedCanisters).find(
    ([name]) => name.toLowerCase() === candidate.toLowerCase(),
  );
  return namedCanister?.[1].id ?? candidate;
}

function rawToConfigValue(
  fieldType: ConfigType,
  raw: RawValue,
  installedCanisters: InstalledCanisters,
): ConfigValue | null {
  if ("Vector" in fieldType) {
    if (!Array.isArray(raw)) return null;
    const values: ConfigVectorValue[] = [];
    for (const item of raw) {
      const converted = rawToVectorValue(fieldType.Vector.element_type, item, installedCanisters);
      if (converted === null) return null;
      values.push(converted);
    }
    return { Vector: values };
  }
  if (Array.isArray(raw)) return null;
  return rawToScalarConfigValue(fieldType, raw, installedCanisters);
}

function rawToScalarConfigValue(
  fieldType: ScalarType,
  raw: RawScalarValue,
  installedCanisters: InstalledCanisters,
): ConfigValue | null {
  if (isTextLike(fieldType)) return { Text: String(raw) };
  if ("Number" in fieldType) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return { Number: BigInt(n) };
  }
  if ("Float" in fieldType) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return { Float: n };
  }
  if ("Boolean" in fieldType) return { Boolean: Boolean(raw) };
  if ("CanisterPicker" in fieldType) {
    try {
      return { PrincipalId: Principal.fromText(resolveCanisterId(raw, installedCanisters)) };
    } catch {
      return null;
    }
  }
  return null;
}

function rawToVectorValue(
  fieldType: ConfigVectorType,
  raw: RawScalarValue,
  installedCanisters: InstalledCanisters,
): ConfigVectorValue | null {
  const converted = rawToScalarConfigValue(fieldType, raw, installedCanisters);
  if (!converted || "Vector" in converted) return null;
  return converted;
}

function isBlank(fieldType: ConfigType, raw: RawValue): boolean {
  if ("Vector" in fieldType) return false;
  if (Array.isArray(raw)) return false;
  if ("Boolean" in fieldType) return false;
  return String(raw).trim() === "";
}

function isReadonly(schema: ConfigFieldSchema): boolean {
  return schema.is_readonly[0] ?? false;
}

function canisterPickerType(fieldType: ConfigType): Extract<ConfigVectorType, { CanisterPicker: unknown }> | null {
  if ("CanisterPicker" in fieldType) return fieldType;
  if ("Vector" in fieldType && "CanisterPicker" in fieldType.Vector.element_type) {
    return fieldType.Vector.element_type;
  }
  return null;
}

function canisterOptionsForField(
  schema: ConfigFieldSchema,
  installedCanisters: InstalledCanisters,
): CanisterOption[] {
  const picker = canisterPickerType(schema.field_type);
  if (!picker) return [];

  // Type and package metadata describe the intended/default dependency and
  // can drive package installation suggestions. They must not hide choices:
  // users can intentionally point a setting at any canister in the project.
  return Object.entries(installedCanisters)
    .map(([name, canister]) => ({ name, ...canister }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Picker entries as combobox items - the option's value is the canister's
 * name (saves resolve name -> principal via `resolveCanisterId`), with the
 * ID & kind shown as the row's hint. */
function canisterItems(options: CanisterOption[]) {
  return options.map((option) => ({
    value: option.name,
    label: option.name,
    hint: `${option.id} · ${option.kind}`,
  }));
}

function canisterPickerPlaceholder(fieldType: ConfigType): string {
  const filter = canisterPickerType(fieldType)?.CanisterPicker.module_type_filter[0];
  return filter ? `${filter} name or canister ID` : "Canister name or principal ID";
}

function selectOptionLabel(option: string): string {
  if (option === "managed") return "Managed";
  if (option === "managed_deepseek") return "Managed";
  if (option === "managed_ic_llm") return "Managed";
  if (option === "deepseek") return "DeepSeek (Own API Key)";
  return option;
}

const MANAGED_MODEL_OPTIONS = new Set([
  "deepseek-v4-pro",
  "llama3.1:8b",
  "qwen3:32b",
  "llama4-scout",
  "qwen2.5:0.5b",
]);

function normalizeProvider(provider: string): string {
  return ["managed_deepseek", "managed_ic_llm", "platform"].includes(provider) ? "managed" : provider;
}

function modelOptionsForProvider(provider: string, options: string[]): string[] {
  if (["managed", "managed_deepseek", "managed_ic_llm", "platform"].includes(provider)) {
    return options.filter((option) => MANAGED_MODEL_OPTIONS.has(option));
  }
  if (provider === "openai") return options.filter((option) => option.startsWith("gpt-"));
  if (provider === "anthropic") return options.filter((option) => option.startsWith("claude-"));
  if (provider === "deepseek") return options.filter((option) => option.startsWith("deepseek-"));
  return options;
}

function displayConfigValue(value: ConfigValue | undefined): string {
  if (!value) return "Unavailable";
  if ("Text" in value) return value.Text || "Empty";
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("Boolean" in value) return value.Boolean ? "Yes" : "No";
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  if ("Vector" in value) {
    if (value.Vector.length === 0) return "None";
    return value.Vector.map((item) => String(vectorValueToRaw(item))).join(", ");
  }
  return "Unavailable";
}

interface FieldProps {
  schema: ConfigFieldSchema;
  value: RawValue;
  error?: string;
  canisterOptions: CanisterOption[];
  onChange: (value: RawValue) => void;
}

function Field({ schema, value, error, canisterOptions, onChange }: FieldProps) {
  const fieldType = schema.field_type;
  const inputId = `config-field-${schema.key}`;

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label htmlFor={inputId}>
          {schema.label}
          {schema.is_required && <span className="text-[#ff5252]"> *</span>}
        </Label>
        {"Select" in fieldType === false && "CanisterPicker" in fieldType === false && (
          <span className="text-[9px] text-[#4a5568] uppercase tracking-wide">
            {"Vector" in fieldType ? "list" : "SecretText" in fieldType ? "secret" : "Boolean" in fieldType ? "" : Object.keys(fieldType)[0]}
          </span>
        )}
      </div>

      {"Vector" in fieldType ? (
        <VectorField
          inputId={inputId}
          fieldType={fieldType.Vector.element_type}
          value={Array.isArray(value) ? value : []}
          canisterOptions={canisterOptions}
          onChange={onChange}
        />
      ) : "Boolean" in fieldType ? (
        <Toggle checked={Boolean(value)} onChange={(v) => onChange(v)} />
      ) : "Select" in fieldType ? (
        <Select
          id={inputId}
          value={String(value)}
          onChange={(next) => onChange(next)}
          placeholder="Select…"
          options={fieldType.Select.options.map((option) => ({ value: option, label: selectOptionLabel(option) }))}
        />
      ) : "TextArea" in fieldType ? (
        <Textarea
          id={inputId}
          rows={6}
          className="font-mono"
          placeholder="shop.example.com\nwww.shop.example.com"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : "CanisterPicker" in fieldType ? (
        <Combobox
          id={inputId}
          value={String(value)}
          onChange={(next) => onChange(next)}
          placeholder={canisterPickerPlaceholder(fieldType)}
          options={canisterItems(canisterOptions)}
        />
      ) : (
        <Input
          id={inputId}
          type={"SecretText" in fieldType ? "password" : "Number" in fieldType || "Float" in fieldType ? "number" : "text"}
          step={"Float" in fieldType ? "any" : undefined}
          value={String(value)}
          placeholder={"SecretText" in fieldType && String(value) === MASKED_SECRET ? "Set - enter a new value to replace it" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {schema.description && <p className="text-[10px] text-[#4a5568] mt-1">{schema.description}</p>}
      {error && <p className="text-[10px] text-[#ff5252] mt-1">{error}</p>}
    </div>
  );
}

function emptyVectorItem(fieldType: ConfigVectorType): RawScalarValue {
  if ("Boolean" in fieldType) return false;
  if ("Select" in fieldType) return fieldType.Select.options[0] ?? "";
  return "";
}

interface VectorFieldProps {
  inputId: string;
  fieldType: ConfigVectorType;
  value: RawScalarValue[];
  canisterOptions: CanisterOption[];
  onChange: (value: RawValue) => void;
}

function VectorField({ inputId, fieldType, value, canisterOptions, onChange }: VectorFieldProps) {
  const replace = (index: number, item: RawScalarValue) => {
    const next = [...value];
    next[index] = item;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {value.map((item, index) => (
        <div key={`${inputId}-${index}`} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            {"Boolean" in fieldType ? (
              <Toggle checked={Boolean(item)} onChange={(next) => replace(index, next)} />
            ) : "Select" in fieldType ? (
              <Select
                id={`${inputId}-${index}`}
                value={String(item)}
                onChange={(next) => replace(index, next)}
                options={fieldType.Select.options.map((option) => ({ value: option, label: selectOptionLabel(option) }))}
              />
            ) : "CanisterPicker" in fieldType ? (
              <Combobox
                id={`${inputId}-${index}`}
                value={String(item)}
                onChange={(next) => replace(index, next)}
                placeholder="Canister name or principal ID"
                options={canisterItems(canisterOptions)}
              />
            ) : (
              <Input
                id={`${inputId}-${index}`}
                type={"SecretText" in fieldType ? "password" : "Number" in fieldType || "Float" in fieldType ? "number" : "text"}
                step={"Float" in fieldType ? "any" : undefined}
                value={String(item)}
                placeholder={"SecretText" in fieldType && String(item) === MASKED_SECRET ? "Set - enter a new value to replace it" : undefined}
                onChange={(e) => replace(index, e.target.value)}
              />
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(value.filter((_, i) => i !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...value, emptyVectorItem(fieldType)])}>
        + Add item
      </Button>
    </div>
  );
}

export interface ConfigFormProps {
  schema: ConfigFieldSchema[];
  initialValues: Record<string, ConfigValue>;
  installedCanisters?: InstalledCanisters;
  onSubmit: (changed: Record<string, ConfigValue>) => Promise<void>;
  projectId?: string;
  network?: string;
  onCanisterInstalled?: (canister: DeployedCanister) => void;
}

interface EditableFieldProps {
  schema: ConfigFieldSchema;
  initialValue: ConfigValue | undefined;
  installedCanisters: InstalledCanisters;
  onSubmit: ConfigFormProps["onSubmit"];
  onRawChange?: (value: RawValue) => void;
  onInstallPackage?: (packageName: string, onInstalled: (canisterId: string) => void) => void;
}

interface FieldGroup {
  key: string;
  label: string | null;
  description: string | null;
  fields: ConfigFieldSchema[];
}

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Preserves schema order while collecting fields that share a group key.
 * Ungrouped fields remain independent, matching older modules' layout. */
function groupFields(fields: ConfigFieldSchema[]): FieldGroup[] {
  const result: FieldGroup[] = [];
  const grouped = new Map<string, FieldGroup>();

  for (const field of fields) {
    const key = field.group[0];
    if (!key) {
      result.push({ key: `field:${field.key}`, label: null, description: null, fields: [field] });
      continue;
    }

    let group = grouped.get(key);
    if (!group) {
      group = {
        key: `group:${key}`,
        label: field.group_label[0] ?? titleCase(key),
        description: field.group_description[0] ?? null,
        fields: [],
      };
      grouped.set(key, group);
      result.push(group);
    } else {
      group.label ??= field.group_label[0] ?? titleCase(key);
      group.description ??= field.group_description[0] ?? null;
    }
    group.fields.push(field);
  }

  return result;
}

function FoldableGroup({ group, children }: { group: FieldGroup; children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      className="group rounded-md border border-[#1e2d47] bg-[#0a0e1a44]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h4 className="text-xs font-medium text-[#e2e8f0]">{group.label}</h4>
          {group.description && <p className="mt-0.5 text-[10px] leading-relaxed text-[#4a5568]">{group.description}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 text-[#4a5568]">
          <span className="text-[9px] uppercase tracking-wide">{group.fields.length} {group.fields.length === 1 ? "setting" : "settings"}</span>
          <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
        </div>
      </summary>
      <div className="space-y-3 border-t border-[#1e2d47] p-3">{children}</div>
    </details>
  );
}

function EditableField({ schema, initialValue, installedCanisters, onSubmit, onRawChange, onInstallPackage }: EditableFieldProps) {
  const [value, setValue] = useState<RawValue>(() => configValueToRaw(schema.field_type, initialValue));
  const [dirty, setDirty] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const requiredPackageName = schema.package_name[0];
  const packageAlreadyInstalled = requiredPackageName
    ? Object.values(installedCanisters).some((canister) => canister.packageName?.toLowerCase() === requiredPackageName.toLowerCase())
    : true;
  const showInstallPackage = Boolean(requiredPackageName && canisterPickerType(schema.field_type) && !packageAlreadyInstalled);

  const change = (next: RawValue) => {
    setValue(next);
    onRawChange?.(next);
    setDirty(true);
    setSaved(false);
    setFieldError(undefined);
    setSubmitError(undefined);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || submitting) return;

    if (schema.is_required && isBlank(schema.field_type, value)) {
      setFieldError("Required");
      return;
    }
    if (isBlank(schema.field_type, value)) {
      setFieldError("Optional scalar values cannot currently be cleared; enter a value or leave this field unchanged");
      return;
    }

    const converted = rawToConfigValue(schema.field_type, value, installedCanisters);
    if (converted === null) {
      setFieldError(canisterPickerType(schema.field_type) ? "Enter an installed canister name or a valid canister ID" : "Not a valid value");
      return;
    }

    setSubmitting(true);
    setSubmitError(undefined);
    try {
      // Dynamic set_config is a partial merge. Sending exactly one key makes
      // this save independent from every other edited field on the page.
      await onSubmit({ [schema.key]: converted });
      setDirty(false);
      setSaved(true);
      // Secrets are write-only on the canister side: never keep the
      // freshly-submitted plaintext in the input - replace it with the
      // mask, which is what any reload would show anyway.
      if (isSecretType(schema.field_type)) {
        setValue(Array.isArray(value) ? value.map(() => MASKED_SECRET) : MASKED_SECRET);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={save} className="rounded-md border border-[#1e2d47] bg-[#0a0e1a55] p-3">
      <Field
        schema={schema}
        value={value}
        error={fieldError}
        canisterOptions={canisterOptionsForField(schema, installedCanisters)}
        onChange={change}
      />
      {showInstallPackage && requiredPackageName && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded border border-[#1e2d47] bg-[#0a0e1a66] px-3 py-2">
          <p className="text-[10px] text-[#8892a4]">This setting needs <span className="font-mono text-[#e2e8f0]">{requiredPackageName}</span>.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => onInstallPackage?.(requiredPackageName, (canisterId) => {
              if ("Vector" in schema.field_type && Array.isArray(value)) change([...value, canisterId]);
              else change(canisterId);
            })}
          >
            <PackagePlus size={12} /> Install package
          </Button>
        </div>
      )}
      {submitError && <p className="mt-2 text-[10px] text-[#ff5252]">{submitError}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!dirty || submitting}>
          {submitting ? "Saving…" : `Save ${schema.label}`}
        </Button>
        {dirty && !submitting && <span className="text-[10px] text-[#f6c85f]">Unsaved</span>}
        {saved && !dirty && <span className="text-[10px] text-[#48bb78]">Saved</span>}
      </div>
    </form>
  );
}

export function ConfigForm({ schema, initialValues, installedCanisters = {}, onSubmit, projectId, network, onCanisterInstalled }: ConfigFormProps) {
  const initialProvider = (() => {
    const value = initialValues.llm_provider;
    return value && "Text" in value ? normalizeProvider(value.Text) : "";
  })();
  const [llmProvider, setLlmProvider] = useState(initialProvider);
  const [installTarget, setInstallTarget] = useState<{
    packageName: string;
    onInstalled: (canisterId: string) => void;
  } | null>(null);
  useEffect(() => setLlmProvider(initialProvider), [initialProvider]);

  const editableSchema = schema.filter((field) => !isReadonly(field));
  const readonlySchema = schema.filter(isReadonly);
  const editableGroups = groupFields(editableSchema);
  const readonlyGroups = groupFields(readonlySchema);

  if (schema.length === 0) {
    return <p className="text-sm text-[#4a5568]">This module has no configurable settings.</p>;
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a66] p-4">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[#e2e8f0]">Editable configuration</h3>
            <p className="mt-1 text-[10px] text-[#4a5568]">Values managed through this settings page.</p>
          </div>

          {editableSchema.length > 0 ? (
            <div className="space-y-4">
              {editableGroups.map((group) => {
                const fields = group.fields.map((field) => {
                  const storedInitialValue = initialValues[field.key] ?? field.default_value[0];
                  const displayedInitialValue = field.key === "llm_provider"
                    && storedInitialValue
                    && "Text" in storedInitialValue
                    ? { Text: normalizeProvider(storedInitialValue.Text) }
                    : storedInitialValue;
                  const displayedField = field.key === "llm_model" && "Select" in field.field_type
                    ? {
                        ...field,
                        field_type: {
                          Select: {
                            options: modelOptionsForProvider(llmProvider, field.field_type.Select.options),
                          },
                        },
                      }
                    : field;
                  return (
                    <EditableField
                      key={field.key}
                      schema={displayedField}
                      initialValue={displayedInitialValue}
                      installedCanisters={installedCanisters}
                      onSubmit={onSubmit}
                      onInstallPackage={(packageName, onInstalled) => setInstallTarget({ packageName, onInstalled })}
                      onRawChange={field.key === "llm_provider"
                        ? (value) => setLlmProvider(Array.isArray(value) ? "" : String(value))
                        : undefined}
                    />
                  );
                });
                return group.label ? <FoldableGroup key={group.key} group={group}>{fields}</FoldableGroup> : fields;
              })}
            </div>
          ) : (
            <p className="text-xs text-[#4a5568]">This module has no editable settings.</p>
          )}
        </section>

        <section className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a66] p-4">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[#e2e8f0]">Read-only canister data</h3>
            <p className="mt-1 text-[10px] text-[#4a5568]">Values reported and managed by the canister.</p>
          </div>

          {readonlySchema.length > 0 ? (
            <div className="space-y-4">
              {readonlyGroups.map((group) => {
                const fields = (
                  <dl className="divide-y divide-[#1e2d47]">
                    {group.fields.map((field) => (
                      <div key={field.key} className="py-3 first:pt-0 last:pb-0">
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-[#718096]">{field.label}</dt>
                        <dd className="mt-1 break-all font-mono text-sm text-[#e2e8f0]">{displayConfigValue(initialValues[field.key])}</dd>
                        {field.description && <p className="mt-1 text-[10px] text-[#4a5568]">{field.description}</p>}
                      </div>
                    ))}
                  </dl>
                );
                return group.label ? <FoldableGroup key={group.key} group={group}>{fields}</FoldableGroup> : <div key={group.key}>{fields}</div>;
              })}
            </div>
          ) : (
            <p className="text-xs text-[#4a5568]">This module does not report read-only data.</p>
          )}
        </section>
      </div>
      {projectId && network && (
        <InstallCanisterDialog
          open={installTarget !== null}
          onClose={() => setInstallTarget(null)}
          jobId={projectId}
          network={network}
          onDeployed={(canister) => {
            if (!canister) return;
            installTarget?.onInstalled(canister.id);
            onCanisterInstalled?.(canister);
          }}
          requiredPackageName={installTarget?.packageName}
          navigateToOrchestrate={false}
        />
      )}
    </div>
  );
}
