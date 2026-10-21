import { useState, type ReactNode } from "react";
import { clsx } from "clsx";

interface TooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <div
      className={clsx("relative inline-flex", className)}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 pointer-events-none">
          <div className="px-2 py-1 text-xs text-[#e2e8f0] bg-[#1a2236] border border-[#1e2d47] rounded whitespace-nowrap shadow-lg">
            {content}
          </div>
        </div>
      )}
    </div>
  );
}
