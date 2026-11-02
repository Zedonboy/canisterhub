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
    "bg-c-accent text-c-on-accent font-semibold hover:bg-c-accent-hover active:bg-c-accent-active shadow-[0_0_12px_var(--accent-a33)]",
  secondary:
    "bg-c-surface2 text-c-text border border-c-line hover:bg-c-line hover:border-c-accent-a44",
  outline:
    "bg-transparent text-c-accent border border-c-accent-a44 hover:bg-c-accent-a11 hover:border-c-accent",
  ghost:
    "bg-transparent text-c-muted hover:bg-c-surface2 hover:text-c-text",
  danger:
    "bg-c-danger-a22 text-c-danger border border-c-danger-a44 hover:bg-c-danger-a33 hover:border-c-danger",
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
