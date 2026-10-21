// Renders a `ConfigFieldSchema[]` (from a `#[dynamic_config]` Marketplace
// Module's `get_config_schema`) as editable settings on the left and
// canister-owned read-only data on the right. Field order follows the
// schema's own `Vec` order, not alphabetical - a module author's declared
// field order is the intended reading order.

import { useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { Input, Label } from "@/components/ui/Input";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import type { ConfigFieldSchema, ConfigType, ConfigValue } from "@/lib/moduleConfig";

/** What each field edits as - a plain string for every text-like/numeric
 * field (kept as text while editing, parsed only on submit, so a half-typed
 * number never gets silently coerced mid-keystroke) or a real boolean for
 * `Boolean`. */
type RawValue = string | boolean;

function isTextLike(fieldType: ConfigType): boolean {
  return "Text" in fieldType || "SecretText" in fieldType || "Select" in fieldType;
}

function configValueToRaw(fieldType: ConfigType, value: ConfigValue | undefined): RawValue {
  if ("Boolean" in fieldType) return value && "Boolean" in value ? value.Boolean : false;
  if (!value) return "";
  if ("Text" in value) return value.Text;
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  return "";
}

/** `null` return means "couldn't convert" - the caller turns that into an
 * inline field error rather than silently dropping or guessing a value. */
function rawToConfigValue(fieldType: ConfigType, raw: RawValue): ConfigValue | null {
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
      return { PrincipalId: Principal.fromText(String(raw).trim()) };
    } catch {
      return null;
    }
  }
  return null;
}

function isBlank(fieldType: ConfigType, raw: RawValue): boolean {
  if ("Boolean" in fieldType) return false;
  return String(raw).trim() === "";
}

function isReadonly(schema: ConfigFieldSchema): boolean {
  return schema.is_readonly[0] ?? false;
}

function displayConfigValue(value: ConfigValue | undefined): string {
  if (!value) return "Unavailable";
  if ("Text" in value) return value.Text || "Empty";
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("Boolean" in value) return value.Boolean ? "Yes" : "No";
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  return "Unavailable";
}

interface FieldProps {
  schema: ConfigFieldSchema;
  value: RawValue;
  error?: string;
  onChange: (value: RawValue) => void;
}

function Field({ schema, value, error, onChange }: FieldProps) {
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
            {"SecretText" in fieldType ? "secret" : "Boolean" in fieldType ? "" : Object.keys(fieldType)[0]}
          </span>
        )}
      </div>

      {"Boolean" in fieldType ? (
        <Toggle checked={Boolean(value)} onChange={(v) => onChange(v)} />
      ) : "Select" in fieldType ? (
        <select
          id={inputId}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors"
        >
          <option value="" disabled>
            Select…
          </option>
          {fieldType.Select.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={inputId}
          type={"SecretText" in fieldType ? "password" : "Number" in fieldType || "Float" in fieldType ? "number" : "text"}
          step={"Float" in fieldType ? "any" : undefined}
          placeholder={
            "CanisterPicker" in fieldType
              ? fieldType.CanisterPicker.module_type_filter.length > 0
                ? `${fieldType.CanisterPicker.module_type_filter[0]} canister id`
                : "aaaaa-aa"
              : undefined
          }
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {schema.description && <p className="text-[10px] text-[#4a5568] mt-1">{schema.description}</p>}
      {error && <p className="text-[10px] text-[#ff5252] mt-1">{error}</p>}
    </div>
  );
}

export interface ConfigFormProps {
  schema: ConfigFieldSchema[];
  initialValues: Record<string, ConfigValue>;
  onSubmit: (changed: Record<string, ConfigValue>) => Promise<void>;
}

export function ConfigForm({ schema, initialValues, onSubmit }: ConfigFormProps) {
  const editableSchema = schema.filter((field) => !isReadonly(field));
  const readonlySchema = schema.filter(isReadonly);
  const [values, setValues] = useState<Record<string, RawValue>>(() =>
    Object.fromEntries(
      editableSchema.map((field) => [field.key, configValueToRaw(field.field_type, initialValues[field.key])])
    )
  );
  // Only touched fields are ever sent to `set_config` - see `setModuleConfig`'s
  // own doc comment. This also means an untouched `SecretText` field, whose
  // displayed value may be the server's own "•••••••• " mask (a
  // non-controller caller - see `ic::config`'s doc comment on why that
  // masking exists at all), can never get written back as if it were real.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setField = (key: string, value: RawValue) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTouched((t) => new Set(t).add(key));
    setFieldErrors((errs) => {
      if (!(key in errs)) return errs;
      const { [key]: _removed, ...rest } = errs;
      return rest;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (touched.size === 0) return;

    const changed: Record<string, ConfigValue> = {};
    const errors: Record<string, string> = {};
    for (const field of editableSchema) {
      if (!touched.has(field.key)) continue;
      const raw = values[field.key];
      if (field.is_required && isBlank(field.field_type, raw)) {
        errors[field.key] = "Required";
        continue;
      }
      if (isBlank(field.field_type, raw) && !field.is_required) continue; // clearing an optional field back to "unset" isn't supported by a partial merge - just don't send it
      const converted = rawToConfigValue(field.field_type, raw);
      if (converted === null) {
        errors[field.key] = "CanisterPicker" in field.field_type ? "Not a valid canister id" : "Not a valid value";
        continue;
      }
      changed[field.key] = converted;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(changed);
      setTouched(new Set());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (schema.length === 0) {
    return <p className="text-sm text-[#4a5568]">This module has no configurable settings.</p>;
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-[#1e2d47] bg-[#0a0e1a66] p-4">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[#e2e8f0]">Editable configuration</h3>
            <p className="mt-1 text-[10px] text-[#4a5568]">Values managed through this settings page.</p>
          </div>

          {editableSchema.length > 0 ? (
            <div className="space-y-4">
              {editableSchema.map((field) => (
                <Field
                  key={field.key}
                  schema={field}
                  value={values[field.key]}
                  error={fieldErrors[field.key]}
                  onChange={(v) => setField(field.key, v)}
                />
              ))}

              {submitError && <p className="text-xs text-[#ff5252]">{submitError}</p>}

              <div className="flex items-center gap-2 pt-2">
                <Button type="submit" variant="primary" size="sm" disabled={touched.size === 0 || submitting}>
                  {submitting ? "Saving…" : "Save changes"}
                </Button>
                {touched.size > 0 && !submitting && (
                  <span className="text-[10px] text-[#4a5568]">
                    {touched.size} field{touched.size === 1 ? "" : "s"} changed
                  </span>
                )}
              </div>
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
            <dl className="divide-y divide-[#1e2d47]">
              {readonlySchema.map((field) => (
                <div key={field.key} className="py-3 first:pt-0 last:pb-0">
                  <dt className="text-[10px] font-medium uppercase tracking-wide text-[#718096]">{field.label}</dt>
                  <dd className="mt-1 break-all font-mono text-sm text-[#e2e8f0]">
                    {displayConfigValue(initialValues[field.key])}
                  </dd>
                  {field.description && <p className="mt-1 text-[10px] text-[#4a5568]">{field.description}</p>}
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-[#4a5568]">This module does not report read-only data.</p>
          )}
        </section>
      </div>
    </form>
  );
}
