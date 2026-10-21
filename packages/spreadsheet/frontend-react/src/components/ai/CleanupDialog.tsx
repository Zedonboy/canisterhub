import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAiActivityStore } from '@/stores/ai-activity';
import { readRows } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import type { CleanupResult } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import type { CellUpdate } from '@/lib/storage';
import type { Column, Sheet } from '@/lib/types';
import { MockAiBadge } from './MockAiBadge';

const MAX_ROWS = 20_000;

/** Ported from components/ai/CleanupDialog.svelte. */
export function CleanupDialog({
	open,
	onOpenChange,
	sheet,
	column,
	columns,
	editor,
	onApplied
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheet: Sheet;
	column: Column | null;
	columns: Column[];
	editor: SheetEditor;
	onApplied: (message: string) => void;
}) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [loading, setLoading] = useState(false);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<CleanupResult | null>(null);
	const [selected, setSelected] = useState<string[]>([]);

	async function scan(target: Column) {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const rows = await readRows(sheet.id, columns, Math.min(sheet.row_count, MAX_ROWS));
			const cells = rows.map((row) => ({ rowId: row.id, value: row.data[target.key] ?? null }));
			const outcome = await runAiActivity('cleanup', sheet.name, () => ai.cleanColumn(target, cells), (o) => `${o.proposals.length} fixes proposed for ${target.name}`);
			setResult(outcome);
			setSelected(outcome.proposals.map((proposal) => proposal.id));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		if (!open || !column) return;
		void scan(column);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, column]);

	const chosen = result?.proposals.filter((proposal) => selected.includes(proposal.id)) ?? [];
	/** One update per cell. Trimming goes first so a merge or mapping on the same cell wins. */
	const updates: CellUpdate[] = (() => {
		const byCell = new Map<string, CellUpdate>();
		const ordered = [...chosen].sort((a, b) => Number(b.kind === 'whitespace') - Number(a.kind === 'whitespace'));
		for (const proposal of ordered) {
			for (const update of proposal.updates) byCell.set(`${update.rowId}|${update.columnKey}`, update);
		}
		return [...byCell.values()];
	})();
	const cellCount = updates.length;

	function toggle(id: string, checked: boolean) {
		setSelected((current) => (checked ? [...current, id] : current.filter((candidate) => candidate !== id)));
	}

	async function apply() {
		if (!column || chosen.length === 0) return;
		setApplying(true);
		try {
			const saved = await editor.setCellValues(updates, `AI: Clean ${column.name}`);
			if (!saved) {
				setError(editor.lastError ?? 'The changes could not be saved.');
				return;
			}
			const name = column.name;
			onOpenChange(false);
			onApplied(`Cleaned ${cellCount.toLocaleString()} ${cellCount === 1 ? 'cell' : 'cells'} in ${name}`);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setApplying(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<div className="flex items-center gap-2">
						<DialogTitle>Clean up “{column?.name}”</DialogTitle>
						<MockAiBadge />
					</div>
					<DialogDescription>Nothing changes until you apply. Applied fixes are one undo step.</DialogDescription>
				</DialogHeader>

				{loading ? (
					<p className="py-8 text-center text-sm text-muted-foreground">Checking {Math.min(sheet.row_count, MAX_ROWS).toLocaleString()} rows…</p>
				) : error ? (
					<p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
				) : result ? (
					result.proposals.length === 0 ? (
						<p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
							{result.scanned.toLocaleString()} cells checked. Nothing to clean: spellings, formats and values are already consistent.
						</p>
					) : (
						<ul className="grid gap-2">
							{result.proposals.map((proposal) => {
								const checked = selected.includes(proposal.id);
								return (
									<li key={proposal.id} className="flex gap-3 rounded-lg border p-3">
										<Checkbox
											id={`cleanup-${proposal.id}`}
											checked={checked}
											onCheckedChange={(value) => toggle(proposal.id, value === true)}
											className="mt-0.5"
											aria-label={proposal.title}
										/>
										<div className="grid min-w-0 flex-1 gap-1.5">
											<label htmlFor={`cleanup-${proposal.id}`} className="text-sm font-medium">
												{proposal.title}
											</label>
											<p className="text-xs leading-relaxed text-muted-foreground">{proposal.detail}</p>
											<div className="flex flex-wrap items-center gap-1.5 text-xs">
												{proposal.from.slice(0, 5).map((value) => (
													<span key={value} className="max-w-48 truncate rounded bg-red-50 px-1.5 py-0.5 text-red-800 line-through decoration-red-400">
														{value}
													</span>
												))}
												<ArrowRight className="size-3 text-muted-foreground" />
												<span className="max-w-48 truncate rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800">{proposal.to}</span>
												<span className="text-muted-foreground tabular-nums">
													· {proposal.updates.length.toLocaleString()} {proposal.updates.length === 1 ? 'cell' : 'cells'}
												</span>
											</div>
										</div>
									</li>
								);
							})}
						</ul>
					)
				) : null}

				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={loading || applying || cellCount === 0} onClick={apply}>
						{applying ? 'Applying…' : `Apply to ${cellCount.toLocaleString()} ${cellCount === 1 ? 'cell' : 'cells'}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
