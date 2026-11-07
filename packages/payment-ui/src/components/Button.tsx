// Same button conventions as the dashboard's `frontend/src/components/ui/Button.tsx`,
// re-declared here (like `table-browser` does) so this app stays a
// standalone Vite project with no cross-package imports.

import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-c-accent text-c-on-accent font-semibold hover:bg-c-accent-hover active:bg-c-accent-active",
  secondary:
    "bg-c-surface2 text-c-text border border-c-line hover:border-c-accent-a33",
  ghost: "bg-transparent text-c-muted hover:bg-c-surface2 hover:text-c-text",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
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
