import { Skeleton } from '@/components/ui/skeleton';

const rows = Array.from({ length: 16 }, (_, i) => i);
const widths = ['w-40', 'w-24', 'w-28', 'w-20', 'w-24', 'w-16', 'w-24'];

/** Ported from components/sheet-viewer/GridSkeleton.svelte. */
export function GridSkeleton() {
	return (
		<div className="absolute inset-0 overflow-hidden" aria-busy="true" aria-label="Loading sheet">
			<div className="flex h-9 items-center gap-6 border-b bg-muted/40 px-4">
				{widths.map((width, i) => (
					<Skeleton key={i} className={`h-3 ${width}`} />
				))}
			</div>
			{rows.map((row) => (
				<div key={row} className="flex h-[34px] items-center gap-6 border-b border-zinc-100 px-4" style={{ opacity: 1 - row * 0.05 }}>
					<Skeleton className="h-3 w-6" />
					{widths.map((width, i) => (
						<Skeleton key={i} className={`h-3 ${width}`} />
					))}
				</div>
			))}
		</div>
	);
}
