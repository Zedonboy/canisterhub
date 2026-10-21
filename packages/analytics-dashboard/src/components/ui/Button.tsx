import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-[#00d4ff] text-[#0a0e1a] font-semibold hover:bg-[#00b8d9] active:bg-[#009ab8] shadow-[0_0_12px_#00d4ff33]",
  secondary:
    "bg-[#1a2236] text-[#e2e8f0] border border-[#1e2d47] hover:bg-[#1e2d47] hover:border-[#00d4ff44]",
  outline:
    "bg-transparent text-[#00d4ff] border border-[#00d4ff44] hover:bg-[#00d4ff11] hover:border-[#00d4ff]",
  ghost:
    "bg-transparent text-[#8892a4] hover:bg-[#1a2236] hover:text-[#e2e8f0]",
  danger:
    "bg-[#ff525222] text-[#ff5252] border border-[#ff525244] hover:bg-[#ff525233] hover:border-[#ff5252]",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-5 py-2.5 text-base gap-2",
};

export function Button({ variant = "secondary", size = "md", className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center rounded font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap select-none",
        variants[variant],
        sizes[size],
        className
      )}
    >
      {children}
    </button>
  );
}
