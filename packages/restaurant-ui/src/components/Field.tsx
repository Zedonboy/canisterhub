import type { ReactNode } from "react";
import { clsx } from "clsx";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={clsx("block", className)}><span className="mb-1 block text-xs text-[#8892a4]">{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-[#4a5568]">{hint}</span>}</label>;
}

export function Select({ id, value, onChange, options, className }: { id?: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={clsx("w-full rounded border border-[#1e2d47] bg-[#0a0e1a] px-3 py-2 text-sm text-[#e2e8f0] focus:border-[#00d4ff] focus:outline-none", className)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div className="inline-flex rounded-lg border border-[#1e2d47] bg-[#0a0e1a] p-0.5">{options.map((option) => <button key={option.value} onClick={() => onChange(option.value)} className={clsx("rounded-md px-3 py-1 text-xs transition-colors", option.value === value ? "border border-[#00d4ff22] bg-[#00d4ff11] text-[#00d4ff]" : "border border-transparent text-[#8892a4] hover:text-[#e2e8f0]")}>{option.label}</button>)}</div>;
}
