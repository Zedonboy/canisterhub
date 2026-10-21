import { clsx } from "clsx";
import type { ServiceStatus } from "@/lib/mock-data";

const colorMap: Record<ServiceStatus, string> = {
  healthy: "bg-[#00e676]",
  degraded: "bg-[#ffab40]",
  error: "bg-[#ff5252]",
  stopped: "bg-[#4a5568]",
};

const labelMap: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  error: "Error",
  stopped: "Stopped",
};

interface StatusDotProps {
  status: ServiceStatus;
  showLabel?: boolean;
  className?: string;
}

export function StatusDot({ status, showLabel, className }: StatusDotProps) {
  const isActive = status === "healthy" || status === "degraded";

  return (
    <span className={clsx("inline-flex items-center gap-1.5", className)}>
      <span className="relative inline-flex">
        <span className={clsx("w-2 h-2 rounded-full", colorMap[status])} />
        {isActive && (
          <span
            className={clsx(
              "absolute inset-0 rounded-full animate-pulse-dot",
              colorMap[status],
              "opacity-50"
            )}
          />
        )}
      </span>
      {showLabel && (
        <span className="text-xs text-[#8892a4]">{labelMap[status]}</span>
      )}
    </span>
  );
}
