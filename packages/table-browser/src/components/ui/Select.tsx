// Headless UI `Listbox` styled like this package's other inputs - replaces
// the browser's native <select>, whose dropdown the OS renders and can't
// be themed.

import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { clsx } from "clsx";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown when `value` is empty (or not one of `options`). */
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the closed trigger (e.g. compact sizing). */
  triggerClassName?: string;
  className?: string;
}

export function Select({ id, value, onChange, options, placeholder, disabled, triggerClassName, className }: SelectProps) {
  const selected = options.find((option) => option.value === value);
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className={clsx("relative", className)}>
        <ListboxButton
          id={id}
          className={clsx(
            "flex items-center justify-between gap-2 border border-[#1e2d47] rounded bg-[#0a0e1a] text-left text-[#e2e8f0] transition-colors focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] data-[open]:border-[#00d4ff] data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
            triggerClassName ?? "w-full px-3 py-2 text-sm",
          )}
        >
          <span className={clsx("truncate", !selected && "text-[#4a5568]")}>
            {selected ? selected.label : value || placeholder || "Select…"}
          </span>
          <ChevronDown size={14} className="flex-shrink-0 text-[#4a5568]" />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-60 w-[var(--button-width)] overflow-y-auto rounded-md border border-[#1e2d47] bg-[#0f1629] py-1 text-sm shadow-2xl focus:outline-none"
        >
          {options.map((option) => (
            <ListboxOption
              key={option.value}
              value={option.value}
              className={({ focus }) =>
                clsx(
                  "flex cursor-pointer items-center justify-between gap-2 px-3 py-2",
                  focus ? "bg-[#131929] text-[#e2e8f0]" : "text-[#8892a4]",
                )
              }
            >
              {({ selected }) => (
                <>
                  <span className={clsx("truncate", selected && "text-[#00d4ff]")}>{option.label}</span>
                  {selected && <Check size={14} className="flex-shrink-0 text-[#00d4ff]" />}
                </>
              )}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
