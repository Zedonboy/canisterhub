import { clsx } from "clsx";

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, className }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0",
        checked ? "bg-[#00d4ff]" : "bg-[#1e2d47]",
        disabled && "opacity-40 cursor-not-allowed",
        className
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}
