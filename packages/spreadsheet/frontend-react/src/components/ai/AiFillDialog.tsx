import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAiActivityStore } from '@/stores/ai-activity';
import { readRows } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import type { FillResult } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import { parseCellInput } from '@/lib/editing/cell-input';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import type { CellUpdate } from '@/lib/storage';
import { isEmptyCellValue, type Column, type Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MockAiBadge } from './MockAiBadge';

const MAX_ROWS = 5_000;

function defaultInstruction(target: Column): string {
	if (target.data_type === 'enum') return `Pick the ${target.name.toLowerCase()} that fits each row`;
	if (/merchant|vendor|supplier|payee|company/i.test(target.name)) return `Extract the ${target.name.toLowerCase()} name`;
	if (/sentiment|tone|mood/i.test(target.name)) return 'Is the feedback positive, neutral or negative?';
	return `Extract the ${target.name.toLowerCase()}`;
}

/** Ported from components/ai/AiFillDialog.svelte. */
export function AiFillDialog({
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

	const [instruction, setInstruction] = useState('');
	const [sources, setSources] = useState<string[]>([]);
	const [onlyEmpty, setOnlyEmpty] = useState(true);
	const [preview, setPreview] = useState<FillResult | null>(null);
	const [running, setRunning] = useState(false);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choices = column?.data_type === 'enum' ? (column.settings.options ?? []).map((option) => option.value) : [];
	const sourceOptions = columns.filter((candidate) => candidate.key !== column?.key && candidate.data_type !== 'protected');

	useEffect(() => {
		if (!open || !column) return;
		setPreview(null);
		setError(null);
		setInstruction(localStorage.getItem(`silver:ai:fill:${sheet.id}:${column.key}`) ?? defaultInstruction(column));
		const text = columns.find((candidate) => candidate.key !== column.key && candidate.data_type === 'text' && !candidate.settings.column_formula);
		setSources(text ? [text.key] : []);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, column]);

	async function run() {
		if (!column || !instruction.trim() || sources.length === 0) return;
		const target = column;
		setRunning(true);
		setError(null);
		try {
			localStorage.setItem(`silver:ai:fill:${sheet.id}:${target.key}`, instruction);
			const rows = await readRows(sheet.id, columns, Math.min(sheet.row_count, MAX_ROWS));
			const candidates = rows.filter((row) => !row.has_children && (!onlyEmpty || isEmptyCellValue(row.data[target.key])));
			setPreview(
				await runAiActivity(
					'fill-column',
					sheet.name,
					() => ai.fillColumn({ instruction, sourceKeys: sources, choices }, candidates, target),
					(outcome) => `${outcome.values.filter((value) => value.output).length} values for ${target.name}`
				)
			);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	const updates: CellUpdate[] = !preview || !column
		? []
		: preview.values.flatMap((value) => {
				if (!value.output) return [];
				const parsed = parseCellInput(column, value.output);
				return parsed.ok ? [{ rowId: value.rowId, columnKey: column.key, value: parsed.value }] : [];
			});
	const lowConfidence = preview?.values.filter((value) => value.output && value.confidence < 0.5).length ?? 0;
	const blank = preview?.values.filter((value) => !value.output).length ?? 0;

	async function apply() {
		if (!column || updates.length === 0) return;
		setApplying(true);
		try {
			const saved = await editor.setCellValues(updates, `AI: Fill ${column.name}`);
			if (!saved) {
				setError(editor.lastError ?? 'The changes could not be saved.');
				return;
			}
			const name = column.name;
			onOpenChange(false);
			onApplied(`Filled ${updates.length.toLocaleString()} ${updates.length === 1 ? 'cell' : 'cells'} in ${name}`);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setApplying(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<div className="flex items-center gap-2">
						<DialogTitle>Fill “{column?.name}” with AI</DialogTitle>
						<MockAiBadge />
					</div>
					<DialogDescription>Applies one instruction to every row, reading the columns you choose. Preview first; filling is one undo step.</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-2">
						<Label htmlFor="fill-instruction">Instruction</Label>
						<Textarea id="fill-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={2} />
						{choices.length > 0 ? (
							<p className="text-xs text-muted-foreground">Answers are limited to this column’s options: {choices.join(', ')}.</p>
						) : (
							<p className="text-xs text-muted-foreground">To pick from a list, write it after a colon, e.g. “Category: Travel, Software, Office, Other”.</p>
						)}
					</div>

					<fieldset className="grid gap-2">
						<legend className="mb-1 text-sm font-medium">Read from</legend>
						<div className="flex flex-wrap gap-x-4 gap-y-2">
							{sourceOptions.map((source) => (
								<div key={source.key} className="flex items-center gap-2">
									<Checkbox
										id={`fill-source-${source.key}`}
										checked={sources.includes(source.key)}
										onCheckedChange={(value) => setSources((current) => (value === true ? [...current, source.key] : current.filter((key) => key !== source.key)))}
									/>
									<Label htmlFor={`fill-source-${source.key}`} className="font-normal">
										{source.name}
									</Label>
								</div>
							))}
						</div>
					</fieldset>

					<div className="flex items-center gap-2">
						<Checkbox id="fill-only-empty" checked={onlyEmpty} onCheckedChange={(value) => setOnlyEmpty(value === true)} />
						<Label htmlFor="fill-only-empty" className="font-normal">
							Only fill empty cells
						</Label>
					</div>

					<div>
						<Button type="button" variant="outline" size="sm" disabled={running || !instruction.trim() || sources.length === 0} onClick={run}>
							{running ? 'Working…' : preview ? 'Preview again' : 'Preview'}
						</Button>
					</div>

					{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

					{preview && (
						<>
							<p className="text-xs text-muted-foreground">
								{preview.values.length.toLocaleString()} rows read · <span className="font-medium text-foreground">{updates.length.toLocaleString()} ready</span>
								{lowConfidence > 0 && (
									<>
										{' '}
										· <span className="text-amber-800">{lowConfidence} low confidence</span>
									</>
								)}
								{blank > 0 && ` · ${blank} left blank`}
							</p>
							<div className="overflow-x-auto rounded-lg border">
								<table className="w-full text-xs">
									<thead className="bg-muted/50 text-left text-muted-foreground">
										<tr>
											<th className="px-3 py-1.5 font-medium">Row</th>
											<th className="px-3 py-1.5 font-medium">Read</th>
											<th className="px-3 py-1.5 font-medium">{column?.name}</th>
											<th className="px-3 py-1.5 text-right font-medium">Confidence</th>
										</tr>
									</thead>
									<tbody className="divide-y">
										{preview.values.slice(0, 15).map((value) => (
											<tr key={value.rowId} className={cn(value.output && value.confidence < 0.5 && 'bg-amber-50/60')}>
												<td className="px-3 py-1.5 text-muted-foreground tabular-nums">{value.position.toLocaleString()}</td>
												<td className="max-w-64 truncate px-3 py-1.5" title={value.input}>
													{value.input || '—'}
												</td>
												<td className="px-3 py-1.5 font-medium">{value.output || '—'}</td>
												<td className="px-3 py-1.5 text-right tabular-nums">{value.output ? `${Math.round(value.confidence * 100)}%` : ''}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{preview.values.length > 15 && <p className="text-xs text-muted-foreground">Showing 15 of {preview.values.length.toLocaleString()} rows.</p>}
						</>
					)}
				</div>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={applying || updates.length === 0} onClick={apply}>
						{applying ? 'Filling…' : `Fill ${updates.length.toLocaleString()} ${updates.length === 1 ? 'cell' : 'cells'}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
