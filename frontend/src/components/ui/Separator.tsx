import { clsx } from "clsx";

export function Separator({ className, orientation = "horizontal" }: { className?: string; orientation?: "horizontal" | "vertical" }) {
  const isVertical = orientation === "vertical";
  return (
    <div
      className={clsx(
        "bg-[#1e2d47] flex-shrink-0",
        isVertical ? "w-px self-stretch" : "h-px w-full",
        className
      )}
    />
  );
}
