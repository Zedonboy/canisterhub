import { forwardRef } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode, LabelHTMLAttributes } from "react";
import { clsx } from "clsx";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

// `forwardRef` so a caller can focus/select this input imperatively (e.g.
// autofocusing the first field of an inline add-row form) - a plain
// function component would silently drop a `ref` passed to it (React
// strips it before props reach the component), leaving `ref.current` null
// with no error.
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

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      className={clsx(
        "w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] placeholder-[#4a5568] resize-none",
        "focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors",
        className
      )}
    />
  );
}

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
}

export function Label({ children, htmlFor, className, ...rest }: LabelProps) {
  return (
    <label htmlFor={htmlFor} className={clsx("block text-xs text-[#8892a4] mb-1", className)} {...rest}>
      {children}
    </label>
  );
}
