import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { clsx } from "clsx";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

// `forwardRef` so a caller can focus/select this input imperatively (e.g.
// autofocusing the first field of an inline add-row form) - a plain
// function component would silently drop a `ref` passed to it.
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      className={clsx(
        "w-full px-3 py-2 text-sm bg-c-bg border border-c-line rounded text-c-text placeholder-c-faint",
        "focus:outline-none focus:border-c-accent focus:ring-1 focus:ring-c-accent-a33 transition-colors",
        className
      )}
    />
  );
});
