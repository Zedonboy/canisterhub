import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("w-full overflow-x-auto", className)}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-[#1e2d47]">{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Th({ className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      className={clsx(
        "px-4 py-2.5 text-left text-xs font-medium text-[#8892a4] uppercase tracking-wider",
        className
      )}
    >
      {children}
    </th>
  );
}

export function Tr({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...rest}
      className={clsx(
        "border-b border-[#162035] hover:bg-[#131929] transition-colors",
        className
      )}
    >
      {children}
    </tr>
  );
}

export function Td({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td {...rest} className={clsx("px-4 py-3 text-[#e2e8f0]", className)}>
      {children}
    </td>
  );
}
