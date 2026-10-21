import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

interface CardProps extends HTMLAttributes<HTMLDivElement> {}

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div {...rest} className={clsx("rounded bg-[#0f1629] border border-[#1e2d47]", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      className={clsx("px-4 py-3 border-b border-[#1e2d47] flex items-center justify-between", className)}
    >
      {children}
    </div>
  );
}

export function CardContent({ className, children, ...rest }: CardProps) {
  return (
    <div {...rest} className={clsx("p-4", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={clsx("text-sm font-medium text-[#e2e8f0]", className)}>
      {children}
    </h3>
  );
}
