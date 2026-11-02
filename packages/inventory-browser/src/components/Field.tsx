import type { ReactNode, SelectHTMLAttributes } from "react";
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

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={clsx(
        "w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0]",
        "focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors",
        className
      )}
    />
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
