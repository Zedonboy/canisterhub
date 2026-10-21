import { Button } from '@/components/ui/button';
import { AI_MONTHLY_CREDITS, useAiActivityStore, usedThisMonth } from '@/stores/ai-activity';
import { AI_FEATURE_LABELS } from '@/lib/ai/types';
import { timeLabel } from '@/lib/ai/ui';
import { cn } from '@/lib/utils';

const STATUS_STYLES = {
	ok: 'bg-emerald-50 text-emerald-700',
	failed: 'bg-red-50 text-red-700',
	blocked: 'bg-amber-50 text-amber-800'
} as const;
const STATUS_LABELS = { ok: 'Done', failed: 'Failed', blocked: 'Blocked' } as const;

/** Ported from components/ai/tabs/ActivityTab.svelte. */
export function ActivityTab() {
	const entries = useAiActivityStore((state) => state.entries);
	const reset = useAiActivityStore((state) => state.reset);
	const used = usedThisMonth(entries);
	const share = Math.min(100, (used / AI_MONTHLY_CREDITS) * 100);

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-2">
				<div className="flex items-baseline justify-between gap-2">
					<h3 className="text-sm font-medium">Credits this month</h3>
					<span className="text-sm text-muted-foreground tabular-nums">
						{used} of {AI_MONTHLY_CREDITS}
					</span>
				</div>
				<div
					className="h-2 overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-valuenow={used}
					aria-valuemin={0}
					aria-valuemax={AI_MONTHLY_CREDITS}
					aria-label="AI credits used"
				>
					<div className={cn('h-full rounded-full transition-[width]', share > 90 ? 'bg-red-500' : 'bg-violet-500')} style={{ width: `${share}%` }} />
				</div>
				<p className="text-xs text-muted-foreground">
					Mock credits stand in for model cost and stop requests at the monthly limit. Each request is logged below with its sheet. The log stays in this browser.
				</p>
			</div>

			{entries.length === 0 ? (
				<p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No AI requests yet.</p>
			) : (
				<>
					<ol className="grid divide-y rounded-lg border">
						{entries.slice(0, 60).map((entry) => (
							<li key={entry.id} className="grid gap-0.5 px-3 py-2">
								<div className="flex items-center gap-2 text-xs">
									<span className="font-medium">{AI_FEATURE_LABELS[entry.feature]}</span>
									<span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_STYLES[entry.status])}>{STATUS_LABELS[entry.status]}</span>
									<span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
										{entry.credits} cr · {timeLabel(entry.at)}
									</span>
								</div>
								<p className="truncate text-xs text-muted-foreground" title={entry.summary}>
									{entry.sheetName ? `${entry.sheetName} · ` : ''}
									{entry.summary}
								</p>
							</li>
						))}
					</ol>
					<Button variant="outline" size="sm" className="self-start" onClick={reset}>
						Clear log and reset credits
					</Button>
				</>
			)}
		</div>
	);
}
