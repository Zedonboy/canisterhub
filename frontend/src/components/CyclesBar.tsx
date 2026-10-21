import { clsx } from "clsx";
import { formatCycles } from "@/lib/mock-data";

interface CyclesBarProps {
  balance: number;
  max: number;
  showLabel?: boolean;
  className?: string;
}

export function CyclesBar({ balance, max, showLabel, className }: CyclesBarProps) {
  const pct = Math.min(100, (balance / max) * 100);
  const barColor = pct > 50 ? "bg-[#00e676]" : pct > 20 ? "bg-[#ffab40]" : "bg-[#ff5252]";

  return (
    <div className={clsx("flex flex-col gap-1", className)}>
      {showLabel && (
        <div className="flex items-center justify-between text-xs text-[#8892a4]">
          <span>{formatCycles(balance)} cycles</span>
          <span className="font-mono">{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="h-1 bg-[#1e2d47] rounded-full overflow-hidden">
        <div
          className={clsx("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
