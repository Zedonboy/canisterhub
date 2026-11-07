// The module manager: renders this canister's own `get_config_schema` and
// edits values through the controller-only `set_config` (a partial merge -
// only the fields that actually changed are sent). Secrets are write-only
// on the canister side (`canister-hub-sdk` masks `SecretText` for every
// caller, controllers included - the "secret egress" rule), so this panel
// never receives a real secret value: "set" reads back as the mask
// constant, and a freshly-saved secret is immediately replaced with the
// mask in the editor state too, so the plaintext never lingers in the DOM.

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { Principal } from "@icp-sdk/core/principal";
import { Button } from "@/components/Button";
import type {
  ConfigFieldSchema,
  ConfigType,
  ConfigValue,
  ConfigVectorType,
  ConfigVectorValue,
} from "@/lib/candid/payment";
import { getPaymentActor } from "@/lib/paymentActor";

/** What `get_config` returns for a stored secret - the canister masks
 * `SecretText` for every caller, so this is also all we ever display.
 * Never round-trip it into `set_config` (the canister rejects it there
 * too, as a guard against clients doing exactly that). */
const MASKED = "••••••••";

/** Scalar or vector-of-secrets - either way the value is write-only. */
function isSecretField(field: ConfigFieldSchema): boolean {
  return (
    "SecretText" in field.field_type ||
    ("Vector" in field.field_type && "SecretText" in field.field_type.Vector.element_type)
  );
}

interface Group {
  key: string | null;
  label: string;
  description: string;
  fields: ConfigFieldSchema[];
}

function groupFields(schema: ConfigFieldSchema[]): Group[] {
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  for (const field of schema) {
    const key = field.group[0] ?? null;
    let group = groups.get(key ?? "");
    if (!group) {
      group = {
        key,
        label: field.group_label[0] ?? (key ? key.replaceAll("_", " ") : "General"),
        description: field.group_description[0] ?? "",
        fields: [],
      };
      groups.set(key ?? "", group);
      order.push(group);
    }
    group.fields.push(field);
  }
  return order;
}

/** String editor state for one field - the single source the Save button
 * diffs against the loaded values. */
type EditorState = Record<string, string>;

function valueToEditor(value: ConfigValue | undefined): string {
  if (!value) return "";
  if ("Text" in value) return value.Text;
  if ("Number" in value) return value.Number.toString();
  if ("Float" in value) return value.Float.toString();
  if ("Boolean" in value) return value.Boolean ? "true" : "false";
  if ("PrincipalId" in value) return value.PrincipalId.toText();
  if ("Vector" in value) return JSON.stringify(value.Vector);
  return "";
}

function editorToValue(field: ConfigFieldSchema, text: string): ConfigValue | null {
  const t = field.field_type;
  try {
    if ("Text" in t || "TextArea" in t || "SecretText" in t || "Select" in t) return { Text: text };
    if ("Number" in t) return { Number: BigInt(text.trim() || "0") };
    if ("Float" in t) return { Float: Number(text.trim() || "0") };
    if ("Boolean" in t) return { Boolean: text === "true" };
    if ("CanisterPicker" in t) return { PrincipalId: Principal.fromText(text.trim()) };
  } catch {
    return null;
  }
  return null;
}

function inputClass(disabled: boolean): string {
  return clsx(
    "w-full rounded border border-c-line bg-c-surface px-3 py-1.5 text-xs text-c-text placeholder:text-c-faint focus:border-c-accent focus:outline-none",
    disabled && "opacity-60"
  );
}

export default function SettingsPanel() {
  const [schema, setSchema] = useState<ConfigFieldSchema[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editors, setEditors] = useState<EditorState>({});
  const [originals, setOriginals] = useState<EditorState>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const actor = await getPaymentActor();
        const [fields, config] = await Promise.all([actor.get_config_schema(), actor.get_config()]);
        if (cancelled) return;
        setSchema(fields);
        const nextOriginals: EditorState = {};
        for (const [key, value] of config) nextOriginals[key] = valueToEditor(value);
        setOriginals(nextOriginals);
        setEditors((prev) => {
          // Keep edits the user has already made; only fill untouched keys.
          const next = { ...nextOriginals };
          for (const field of fields) {
            if (field.key in prev) next[field.key] = prev[field.key];
          }
          return next;
        });
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => groupFields(schema), [schema]);

  const dirtyKeys = schema
    .filter((field) => !field.is_readonly[0] && editors[field.key] !== originals[field.key])
    .map((field) => field.key);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const actor = await getPaymentActor();
      const updates: Array<[string, ConfigValue]> = [];
      for (const field of schema) {
        if (field.is_readonly[0]) continue;
        const text = editors[field.key] ?? "";
        if (text === originals[field.key]) continue;
        if (text === MASKED) continue;
        const value = editorToValue(field, text);
        if (!value) {
          setSaveError(`"${field.label}" has a value this field type can't accept.`);
          return;
        }
        updates.push([field.key, value]);
      }
      const result = await actor.set_config(updates);
      if ("Err" in result) {
        setSaveError(result.Err);
        return;
      }
      // Secrets are write-only: drop the freshly-submitted plaintext from
      // the editor state immediately, mirroring what a reload would show.
      const secretKeys = new Set(
        schema.filter(isSecretField).map((field) => field.key),
      );
      setOriginals((prev) => {
        const next = { ...prev };
        for (const [key, value] of updates) {
          next[key] = secretKeys.has(key) ? MASKED : valueToEditor(value);
        }
        return next;
      });
      setEditors((prev) => {
        const next = { ...prev };
        for (const [key] of updates) {
          if (secretKeys.has(key)) next[key] = MASKED;
        }
        return next;
      });
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <p className="rounded border border-c-danger/30 bg-c-danger-a22 px-3 py-2 text-xs text-c-danger">
        {loadError}
      </p>
    );
  }

  if (!loaded) {
    return (
      <p className="flex items-center gap-2 px-1 py-4 text-xs text-c-faint">
        <Loader2 size={13} className="animate-spin" /> Loading settings…
      </p>
    );
  }

  return (
    <section className="space-y-5">
      {groups.map((group) => (
        <div key={group.key ?? ""} className="rounded-lg border border-c-line bg-c-surface">
          <header className="border-b border-c-line px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-c-muted">{group.label}</h3>
            {group.description && <p className="mt-0.5 text-[11px] text-c-faint">{group.description}</p>}
          </header>
          <div className="divide-y divide-c-line/60">
            {group.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={editors[field.key] ?? ""}
                onChange={(text) => {
                  setEditors((prev) => ({ ...prev, [field.key]: text }));
                  setSaved(false);
                }}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || dirtyKeys.length === 0}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          Save changes{dirtyKeys.length > 0 ? ` (${dirtyKeys.length})` : ""}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs text-c-ok">
            <Check size={13} /> Saved
          </span>
        )}
        {saveError && <span className="text-xs text-c-danger">{saveError}</span>}
      </div>
    </section>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldSchema;
  value: string;
  onChange: (text: string) => void;
}) {
  const readonly = field.is_readonly[0] ?? false;
  return (
    <div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[220px_1fr] sm:gap-4">
      <div>
        <label className="text-xs font-medium text-c-text">
          {field.label}
          {field.is_required && <span className="text-c-danger"> *</span>}
        </label>
        {field.description && <p className="mt-0.5 text-[10px] leading-relaxed text-c-faint">{field.description}</p>}
      </div>
      <FieldEditor field={field} value={value} onChange={onChange} readonly={readonly} />
    </div>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
  readonly,
}: {
  field: ConfigFieldSchema;
  value: string;
  onChange: (text: string) => void;
  readonly: boolean;
}) {
  const t = field.field_type;
  if (readonly) {
    return <p className="break-all py-1 font-mono text-xs text-c-muted">{value || "—"}</p>;
  }
  if ("Boolean" in t) {
    return (
      <select value={value || "false"} onChange={(e) => onChange(e.target.value)} className={inputClass(false) + " sm:max-w-[120px]"}>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </select>
    );
  }
  if ("Select" in t) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass(false) + " sm:max-w-[260px]"}>
        <option value="">—</option>
        {t.Select.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if ("SecretText" in t) {
    return (
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={value === MASKED ? "unchanged" : undefined}
        autoComplete="off"
        className={inputClass(false) + " sm:max-w-[340px]"}
      />
    );
  }
  if ("TextArea" in t) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={inputClass(false)}
      />
    );
  }
  if ("Vector" in t) {
    return <VectorEditor elementType={t.Vector.element_type} value={value} onChange={onChange} />;
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass(false) + " sm:max-w-[340px]"}
    />
  );
}

/** Vector fields round-trip through the editor state as JSON - the table
 * stays a plain string map that way, and the add/remove controls below
 * keep the JSON honest. */
function VectorEditor({
  elementType,
  value,
  onChange,
}: {
  elementType: ConfigVectorType;
  value: string;
  onChange: (text: string) => void;
}) {
  let entries: ConfigVectorValue[] = [];
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (Array.isArray(parsed)) entries = parsed as ConfigVectorValue[];
  } catch {
    // Broken JSON shouldn't happen (we only ever write valid shapes), but
    // never crash the form over it.
  }

  const write = (next: ConfigVectorValue[]) => onChange(JSON.stringify(next));

  const empty = (): ConfigVectorValue => {
    if ("Number" in elementType) return { Number: 0n };
    if ("Float" in elementType) return { Float: 0 };
    if ("Boolean" in elementType) return { Boolean: false };
    if ("PrincipalId" in elementType) return { PrincipalId: Principal.anonymous() };
    return { Text: "" };
  };

  const render = (entry: ConfigVectorValue): string => {
    if ("Text" in entry) return entry.Text;
    if ("Number" in entry) return entry.Number.toString();
    if ("Float" in entry) return entry.Float.toString();
    if ("Boolean" in entry) return entry.Boolean ? "true" : "false";
    return entry.PrincipalId.toText();
  };

  const parse = (text: string): ConfigVectorValue => {
    if ("Number" in elementType) return { Number: BigInt(text.trim() || "0") };
    if ("Float" in elementType) return { Float: Number(text.trim() || "0") };
    if ("Boolean" in elementType) return { Boolean: text === "true" };
    if ("PrincipalId" in elementType) return { PrincipalId: Principal.fromText(text.trim()) };
    return { Text: text };
  };

  return (
    <div className="space-y-1.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={render(entry)}
            onChange={(e) => {
              try {
                const next = [...entries];
                next[index] = parse(e.target.value);
                write(next);
              } catch {
                // Leave the entry unchanged on a mid-typing principal.
              }
            }}
            className={inputClass(false) + " max-w-[300px]"}
          />
          <Button variant="ghost" size="sm" onClick={() => write(entries.filter((_, i) => i !== index))}>
            <Trash2 size={12} />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => write([...entries, empty()])}>
        <Plus size={12} /> Add
      </Button>
    </div>
  );
}
