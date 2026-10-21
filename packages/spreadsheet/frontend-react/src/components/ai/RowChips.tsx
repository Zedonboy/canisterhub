import type { RowLink } from '@/lib/ai/types';

/** Ported from components/ai/RowChips.svelte. */
export function RowChips({
	rows,
	columnKey,
	onRevealRow,
	limit = 8
}: {
	rows: RowLink[];
	/** Column to select in the revealed row; the primary column when omitted. */
	columnKey?: string;
	onRevealRow: (position: number, columnKey?: string) => void;
	limit?: number;
}) {
	if (rows.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{rows.slice(0, limit).map((row) => (
				<button
					key={row.id}
					type="button"
					className="max-w-full truncate rounded-md border bg-background px-2 py-0.5 text-left text-[11px] hover:border-violet-300 hover:bg-violet-50"
					title={`Go to row ${row.position.toLocaleString()}`}
					onClick={() => onRevealRow(row.position, columnKey)}
				>
					<span className="text-muted-foreground tabular-nums">{row.position.toLocaleString()}</span> · {row.label}
				</button>
			))}
			{rows.length > limit && <span className="self-center text-[11px] text-muted-foreground">+{(rows.length - limit).toLocaleString()} more</span>}
		</div>
	);
}
