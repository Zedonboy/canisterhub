import type { HTMLAttributes } from "react";
import { clsx } from "clsx";

type Variant = "default" | "green" | "amber" | "red" | "cyan" | "gray";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  default: "bg-[#1a2236] text-[#e2e8f0] border-[#1e2d47]",
  green: "bg-[#00e67622] text-[#00e676] border-[#00e67644]",
  amber: "bg-[#ffab4022] text-[#ffab40] border-[#ffab4044]",
  red: "bg-[#ff525222] text-[#ff5252] border-[#ff525244]",
  cyan: "bg-[#00d4ff22] text-[#00d4ff] border-[#00d4ff44]",
  gray: "bg-[#4a556822] text-[#8892a4] border-[#4a556844]",
};

export function Badge({ variant = "default", className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
