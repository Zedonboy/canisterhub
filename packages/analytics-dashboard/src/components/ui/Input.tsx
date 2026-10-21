import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { clsx } from "clsx";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      className={clsx(
        "w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] placeholder-[#4a5568]",
        "focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors",
        className
      )}
    />
  );
});
