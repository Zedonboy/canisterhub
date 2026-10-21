import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAiActivityStore } from '@/stores/ai-activity';
import { buildSheetContext } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import type { Insight } from '@/lib/ai/types';
import { errorMessage, SEVERITY_LABELS, SEVERITY_STYLES } from '@/lib/ai/ui';
import type { Column, Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RowChips } from '../RowChips';

/** Ported from components/ai/tabs/InsightsTab.svelte. */
export function InsightsTab({ sheet, columns, onRevealRow }: { sheet: Sheet; columns: Column[]; onRevealRow: (position: number, columnKey?: string) => void }) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [insights, setInsights] = useState<Insight[] | null>(null);
	const [checked, setChecked] = useState(0);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function run() {
		setRunning(true);
		setError(null);
		try {
			const context = await buildSheetContext(sheet, columns);
			setChecked(context.rows.length);
			setInsights(await runAiActivity('anomalies', sheet.name, () => ai.findAnomalies(context), (result) => `${result.length} alerts`));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<div className="grid gap-0.5">
					<h3 className="text-sm font-medium">Anomaly alerts</h3>
					<p className="text-xs text-muted-foreground">Looks for unusual amounts, possible duplicates, stock close to running out, spending over plan and overdue work.</p>
				</div>
				<Button size="sm" variant={insights ? 'outline' : 'default'} disabled={running} onClick={run}>
					{running ? 'Scanning…' : insights ? 'Scan again' : 'Scan'}
				</Button>
			</div>

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{insights && (
				<>
					<p className="text-xs text-muted-foreground">
						{insights.length === 0 ? 'Nothing unusual' : `${insights.length} ${insights.length === 1 ? 'alert' : 'alerts'}`} in {checked.toLocaleString()}{' '}
						{checked < sheet.row_count ? `of ${sheet.row_count.toLocaleString()} rows` : 'rows'}.
					</p>
					{insights.map((insight) => (
						<article key={insight.id} className="grid gap-2 rounded-lg border p-3">
							<div className="flex items-start gap-2">
								<span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1', SEVERITY_STYLES[insight.severity])}>
									{SEVERITY_LABELS[insight.severity]}
								</span>
								<h4 className="text-sm font-medium">{insight.title}</h4>
							</div>
							<p className="text-sm leading-relaxed text-muted-foreground">{insight.detail}</p>
							<RowChips rows={insight.rows} onRevealRow={onRevealRow} />
						</article>
					))}
				</>
			)}
		</div>
	);
}
