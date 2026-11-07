// Headless UI `Listbox` styled like this storefront's other fields - replaces
// the browser's native <select>, whose dropdown the OS renders and can't be
// themed. Uses the storefront's `c-*` theme tokens (light and dark).

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
  "aria-label"?: string;
  /** Extra classes for the closed trigger (e.g. width sizing). */
  triggerClassName?: string;
  className?: string;
}

export function Select({ id, value, onChange, options, placeholder, disabled, "aria-label": ariaLabel, triggerClassName, className }: SelectProps) {
  const selected = options.find((option) => option.value === value);
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className={clsx("relative", className)}>
        <ListboxButton
          id={id}
          aria-label={ariaLabel}
          className={clsx(
            "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm bg-c-surface border border-c-line rounded-lg text-left text-c-text transition-colors cursor-pointer focus:outline-none focus:border-c-accent focus:ring-1 focus:ring-c-accent-a33 data-[open]:border-c-accent data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
            triggerClassName,
          )}
        >
          <span className="truncate">{selected ? selected.label : value || placeholder || "Select…"}</span>
          <ChevronDown size={14} className="flex-shrink-0 text-c-faint" />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-60 w-[var(--button-width)] overflow-y-auto rounded-lg border border-c-line bg-c-surface py-1 text-sm shadow-xl focus:outline-none"
        >
          {options.map((option) => (
            <ListboxOption
              key={option.value}
              value={option.value}
              className={({ focus }) =>
                clsx(
                  "flex cursor-pointer items-center justify-between gap-2 px-3 py-2",
                  focus ? "bg-c-surface2 text-c-text" : "text-c-muted",
                )
              }
            >
              {({ selected }) => (
                <>
                  <span className={clsx("truncate", selected && "text-c-accent font-medium")}>{option.label}</span>
                  {selected && <Check size={14} className="flex-shrink-0 text-c-accent" />}
                </>
              )}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
