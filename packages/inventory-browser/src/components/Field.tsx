import type { ReactNode } from "react";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { clsx } from "clsx";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="block text-xs text-[#8892a4] mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-[#4a5568] mt-1">{hint}</span>}
    </label>
  );
}

/** Headless UI `Listbox` styled like the inputs above - replaces the
 * browser's native <select>, whose dropdown the OS renders and can't be
 * themed. Options are passed as data, not <option> children. */
export function Select({
  id,
  value,
  onChange,
  options,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Listbox value={value} onChange={onChange}>
      <div className={clsx("relative", className)}>
        <ListboxButton
          id={id}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-left text-[#e2e8f0] transition-colors focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] data-[open]:border-[#00d4ff]"
        >
          <span className="truncate">{selected ? selected.label : value || "Select…"}</span>
          <ChevronDown size={14} className="flex-shrink-0 text-[#4a5568]" />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-60 w-[var(--button-width)] overflow-y-auto rounded-md border border-[#1e2d47] bg-[#0f1629] py-1 shadow-2xl focus:outline-none"
        >
          {options.map((option) => (
            <ListboxOption
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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg border border-[#1e2d47] bg-[#0a0e1a]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "px-3 py-1 text-xs rounded-md transition-colors",
            o.value === value ? "bg-[#00d4ff11] text-[#00d4ff] border border-[#00d4ff22]" : "text-[#8892a4] hover:text-[#e2e8f0] border border-transparent"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
