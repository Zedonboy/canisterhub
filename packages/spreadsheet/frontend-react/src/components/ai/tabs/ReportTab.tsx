import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAiActivityStore } from '@/stores/ai-activity';
import { buildSheetContext, sheetTools } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import { errorMessage } from '@/lib/ai/ui';
import type { Column, Sheet } from '@/lib/types';

/** Ported from components/ai/tabs/ReportTab.svelte. */
export function ReportTab({ sheet, columns }: { sheet: Sheet; columns: Column[] }) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [body, setBody] = useState('');
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	async function write() {
		setRunning(true);
		setError(null);
		try {
			const context = await buildSheetContext(sheet, columns);
			const report = await runAiActivity('report', sheet.name, () => ai.statusReport(context, sheetTools(sheet.id, columns)), (result) => result.title);
			setBody(report.body);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	async function copy() {
		await navigator.clipboard.writeText(body);
		setCopied(true);
		setTimeout(() => setCopied(false), 2_000);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<div className="grid gap-0.5">
					<h3 className="text-sm font-medium">Status report</h3>
					<p className="text-xs text-muted-foreground">
						Totals, progress by status and by parent row, what’s overdue and suggested next steps. Edit it, then copy it into an email or chat.
					</p>
				</div>
				<Button size="sm" variant={body ? 'outline' : 'default'} disabled={running} onClick={write}>
					{running ? 'Writing…' : body ? 'Rewrite' : 'Write report'}
				</Button>
			</div>

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{body && (
				<>
					<Textarea id="ai-report" value={body} onChange={(event) => setBody(event.target.value)} rows={18} className="font-mono text-xs leading-relaxed" aria-label="Status report" />
					<div className="flex items-center gap-2">
						<Button size="sm" variant="outline" onClick={copy}>
							<Copy className="size-3.5" />
							{copied ? 'Copied' : 'Copy report'}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
