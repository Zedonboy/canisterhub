// Headless UI `Combobox` styled as an autocomplete - replaces the
// browser-default <input list>/<datalist> pairing (whose suggestion popup
// the OS renders and can't be themed). Free text stays allowed: typing
// updates `value` directly, and `onChange` also fires with an option's
// value when one is picked, so callers can resolve either a chosen entry
// or raw input (e.g. a pasted principal ID) on submit.
// Visuals mirror `Input` (field) and `Dialog` (panel).

import { useState } from "react";
import {
  Combobox as HeadlessCombobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";

export interface ComboboxItem {
  value: string;
  label: string;
  /** Secondary line/right-hand metadata (e.g. canister ID · kind). */
  hint?: string;
}

interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxItem[];
  placeholder?: string;
  className?: string;
}

export function Combobox({ id, value, onChange, options, placeholder, className }: ComboboxProps) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? options.filter(
        (option) =>
          option.value.toLowerCase().includes(normalized) ||
          option.label.toLowerCase().includes(normalized) ||
          option.hint?.toLowerCase().includes(normalized),
      )
    : options;

  return (
    <HeadlessCombobox
      value={value}
      onChange={(next) => {
        onChange(next ?? "");
        setQuery("");
      }}
      onClose={() => setQuery("")}
    >
      <div className={clsx("relative", className)}>
        <ComboboxInput
          id={id}
          displayValue={(current: string) => current}
          onChange={(event) => {
            setQuery(event.target.value);
            onChange(event.target.value);
          }}
          placeholder={placeholder}
          className="w-full px-3 py-2 pr-8 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] placeholder-[#4a5568] transition-colors focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33]"
        />
        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-2 text-[#4a5568] transition-colors hover:text-[#8892a4]">
          <ChevronDown size={14} />
        </ComboboxButton>
        <ComboboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-60 w-[var(--input-width)] overflow-y-auto rounded-md border border-[#1e2d47] bg-[#0f1629] py-1 shadow-2xl focus:outline-none"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[#4a5568]">No matches</div>
          ) : (
            filtered.map((option) => (
              <ComboboxOption
                key={option.value}
                value={option.value}
                className={({ focus }) =>
                  clsx(
                    "flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm",
                    focus ? "bg-[#131929] text-[#e2e8f0]" : "text-[#8892a4]",
                  )
                }
              >
                {({ selected }) => (
                  <>
                    <span className={clsx("truncate", selected && "text-[#00d4ff]")}>{option.label}</span>
                    {option.hint && (
                      <span className="flex-shrink-0 font-mono text-[10px] text-[#4a5568]">{option.hint}</span>
                    )}
                  </>
                )}
              </ComboboxOption>
            ))
          )}
        </ComboboxOptions>
      </div>
    </HeadlessCombobox>
  );
}
