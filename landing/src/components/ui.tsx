import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#00d4ff33] bg-[#00d4ff0d] text-[#00d4ff] text-xs font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-[#00d4ff] animate-pulse-dot" />
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "center" | "left";
}) {
  return (
    <div className={clsx("space-y-4", align === "center" ? "text-center items-center flex flex-col" : "text-left")}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className={clsx("text-3xl sm:text-4xl font-bold text-[#e2e8f0] tracking-tight", align === "center" && "max-w-2xl")}>{title}</h2>
      {subtitle && <p className={clsx("text-base text-[#8892a4] leading-relaxed", align === "center" ? "max-w-xl" : "max-w-xl")}>{subtitle}</p>}
    </div>
  );
}

/** Where every call-to-action on this site leads. */
export const DASHBOARD_URL = "https://dashboard.canisterhub.io";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
}

function buttonClasses(variant: NonNullable<ButtonProps["variant"]>, size: NonNullable<ButtonProps["size"]>, className?: string) {
  return clsx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all whitespace-nowrap",
    size === "md" ? "px-4 py-2 text-sm" : "px-6 py-3 text-base",
    variant === "primary" && "bg-[#00d4ff] text-[#0a0e1a] hover:bg-[#33ddff] shadow-[0_0_20px_#00d4ff33] hover:shadow-[0_0_28px_#00d4ff55]",
    variant === "secondary" && "border border-[#1e2d47] text-[#e2e8f0] bg-[#ffffff08] hover:bg-[#ffffff12] hover:border-[#00d4ff44]",
    variant === "ghost" && "text-[#8892a4] hover:text-[#e2e8f0]",
    className
  );
}

export function Button({ variant = "primary", size = "md", className, children, ...props }: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

/** A call-to-action that looks like `Button` but is a real link (so it can be
 * opened in a new tab, copied, and followed without JavaScript). */
export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  href = DASHBOARD_URL,
  children,
}: {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  href?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className={buttonClasses(variant, size, className)}>
      {children}
    </a>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx("rounded-xl border border-[#1e2d47] bg-[#0f1629aa] backdrop-blur-sm p-6", className)}>
      {children}
    </div>
  );
}
