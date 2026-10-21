import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useAiActivityStore } from '@/stores/ai-activity';
import { ai } from '@/lib/ai/provider';
import type { ChangeSummary, SheetChangeEntry } from '@/lib/ai/types';
import { errorMessage, timeLabel } from '@/lib/ai/ui';
import { sheetRepository } from '@/lib/storage';
import type { Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';

const PERIODS = [
	{ value: 'hour', label: 'Last hour', since: 'in the last hour' },
	{ value: 'today', label: 'Today', since: 'today' },
	{ value: 'week', label: 'Last 7 days', since: 'in the last 7 days' },
	{ value: 'all', label: 'Everything recorded', since: 'since changes were first recorded' }
] as const;

type Period = (typeof PERIODS)[number]['value'];

function cutoff(value: Period): number {
	const now = Date.now();
	if (value === 'hour') return now - 3_600_000;
	if (value === 'week') return now - 7 * 86_400_000;
	if (value === 'today') return new Date(new Date().toDateString()).getTime();
	return 0;
}

/** Ported from components/ai/tabs/ChangesTab.svelte. */
export function ChangesTab({ sheet }: { sheet: Sheet }) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [period, setPeriod] = useState<Period>('today');
	const [summary, setSummary] = useState<ChangeSummary | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshed, setRefreshed] = useState(0);

	const selected = PERIODS.find((option) => option.value === period)!;

	const entries: SheetChangeEntry[] = (() => {
		void refreshed;
		if (!sheet.writable) return [];
		const since = cutoff(period);
		return sheetRepository.changeLog(sheet.id).filter((entry) => new Date(entry.at).getTime() >= since);
	})();

	async function summarise() {
		setRunning(true);
		setError(null);
		setRefreshed((n) => n + 1);
		try {
			const current = sheetRepository.changeLog(sheet.id).filter((entry) => new Date(entry.at).getTime() >= cutoff(period));
			setSummary(await runAiActivity('changes', sheet.name, () => ai.summarizeChanges(current, selected.since), (result) => result.headline));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-0.5">
				<h3 className="text-sm font-medium">What changed?</h3>
				<p className="text-xs text-muted-foreground">A plain-language summary of recorded edits, undos and AI actions. The change log is kept per sheet in this browser.</p>
			</div>

			{!sheet.writable ? (
				<p className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">Server sheets are view only, so there are no edits to summarise.</p>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<Select
							value={period}
							onValueChange={(value) => {
								setPeriod(value as Period);
								setSummary(null);
							}}
						>
							<SelectTrigger className="h-8 w-48" aria-label="Period">
								{selected.label}
							</SelectTrigger>
							<SelectContent>
								{PERIODS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button size="sm" disabled={running} onClick={summarise}>
							{running ? 'Summarising…' : 'Summarise'}
						</Button>
						<span className="text-xs text-muted-foreground tabular-nums">
							{entries.length.toLocaleString()} recorded {entries.length === 1 ? 'change' : 'changes'}
						</span>
					</div>

					{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

					{summary && (
						<article className="grid gap-2 rounded-lg border p-3">
							<p className="text-sm font-medium leading-relaxed">{summary.headline}</p>
							{summary.bullets.length > 0 && (
								<ul className="grid gap-1 pl-4 text-sm text-muted-foreground">
									{summary.bullets.map((bullet, index) => (
										<li key={index} className="list-disc">
											{bullet}
										</li>
									))}
								</ul>
							)}
						</article>
					)}

					{entries.length > 0 && (
						<div className="grid gap-1">
							<h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recorded</h4>
							<ol className="grid divide-y rounded-lg border text-xs">
								{[...entries]
									.reverse()
									.slice(0, 30)
									.map((entry, index) => (
										<li key={index} className="flex items-center gap-2 px-3 py-1.5">
											<span className="w-16 shrink-0 text-muted-foreground tabular-nums">{timeLabel(entry.at)}</span>
											<span className={cn('min-w-0 flex-1 truncate', entry.label.startsWith('AI:') && 'text-violet-700')}>{entry.label}</span>
											{entry.kind !== 'change' && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{entry.kind}</span>}
										</li>
									))}
							</ol>
						</div>
					)}
				</>
			)}
		</div>
	);
}
