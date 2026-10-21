import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAiActivityStore } from '@/stores/ai-activity';
import { buildSheetContext } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import type { AuditFinding } from '@/lib/ai/types';
import { errorMessage, SEVERITY_LABELS, SEVERITY_STYLES } from '@/lib/ai/ui';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import type { Column, Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RowChips } from '../RowChips';

/** Ported from components/ai/tabs/AuditTab.svelte. */
export function AuditTab({
	sheet,
	columns,
	editor,
	onRevealRow,
	onApplied
}: {
	sheet: Sheet;
	columns: Column[];
	editor: SheetEditor | null;
	onRevealRow: (position: number, columnKey?: string) => void;
	onApplied: (message: string) => void;
}) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [findings, setFindings] = useState<AuditFinding[] | null>(null);
	const [checked, setChecked] = useState(0);
	const [sampled, setSampled] = useState(false);
	const [applied, setApplied] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const columnName = (key: string) => columns.find((column) => column.key === key)?.name ?? key;

	async function run() {
		setRunning(true);
		setError(null);
		try {
			const context = await buildSheetContext(sheet, columns);
			setChecked(context.rows.length);
			setSampled(context.sampled);
			setFindings(await runAiActivity('audit', sheet.name, () => ai.audit(context), (result) => `${result.length} findings`));
			setApplied([]);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	async function applyFix(finding: AuditFinding) {
		if (!editor || !finding.fix) return;
		try {
			const saved = await editor.setCellValues(finding.fix.updates, `AI: ${finding.fix.label}`);
			if (!saved) {
				setError(editor.lastError ?? 'The fix could not be saved.');
				return;
			}
			setApplied((current) => [...current, finding.id]);
			onApplied(`${finding.fix.label} (${finding.fix.updates.length.toLocaleString()} ${finding.fix.updates.length === 1 ? 'cell' : 'cells'})`);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<div className="grid gap-0.5">
					<h3 className="text-sm font-medium">Formula risk audit</h3>
					<p className="text-xs text-muted-foreground">Finds fixed ranges that miss new rows, one-off formulas, typed-over calculations, broken references and divide-by-zero.</p>
				</div>
				<Button size="sm" variant={findings ? 'outline' : 'default'} disabled={running} onClick={run}>
					{running ? 'Checking…' : findings ? 'Run again' : 'Run audit'}
				</Button>
			</div>

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{findings && (
				<>
					<p className="text-xs text-muted-foreground">
						{findings.length === 0 ? 'No formula risks found' : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`} in {checked.toLocaleString()}{' '}
						{sampled ? `of ${sheet.row_count.toLocaleString()} rows` : 'rows'}.
					</p>
					{findings.map((finding) => {
						const done = applied.includes(finding.id);
						return (
							<article key={finding.id} className={cn('grid gap-2 rounded-lg border p-3', done && 'opacity-60')}>
								<div className="flex items-start gap-2">
									<span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1', SEVERITY_STYLES[finding.severity])}>
										{SEVERITY_LABELS[finding.severity]}
									</span>
									<h4 className="text-sm font-medium">{finding.title}</h4>
								</div>
								<p className="text-sm leading-relaxed text-muted-foreground">{finding.detail}</p>
								<RowChips
									rows={finding.cells.map((cell) => ({ id: `${cell.rowId}:${cell.columnKey}`, position: cell.position, label: columnName(cell.columnKey) }))}
									columnKey={finding.cells[0]?.columnKey}
									onRevealRow={onRevealRow}
								/>
								{finding.fix && (
									<div className="flex items-center gap-2">
										{done ? (
											<span className="text-xs text-emerald-700">Applied · undo with Ctrl+Z</span>
										) : editor ? (
											<>
												<Button size="xs" variant="outline" onClick={() => applyFix(finding)}>
													{finding.fix.label}
												</Button>
												<span className="text-[11px] text-muted-foreground">{finding.fix.updates.length.toLocaleString()} cells, one undo step</span>
											</>
										) : (
											<span className="text-[11px] text-muted-foreground">Fix available on editable sheets: {finding.fix.label}</span>
										)}
									</div>
								)}
							</article>
						);
					})}
				</>
			)}
		</div>
	);
}
