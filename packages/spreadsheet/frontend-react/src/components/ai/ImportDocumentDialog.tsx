import { Trash2, Upload } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAiActivityStore } from '@/stores/ai-activity';
import { SAMPLE_DOCUMENTS } from '@/lib/ai/mock/extract';
import { ai } from '@/lib/ai/provider';
import type { ExtractedRow, ExtractResult } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import { parseCellInput } from '@/lib/editing/cell-input';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import type { CellValue, Column, Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MockAiBadge } from './MockAiBadge';

/** Ported from components/ai/ImportDocumentDialog.svelte. */
export function ImportDocumentDialog({
	open,
	onOpenChange,
	sheet,
	columns,
	editor,
	onApplied
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheet: Sheet;
	columns: Column[];
	editor: SheetEditor;
	onApplied: (message: string) => void;
}) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [document, setDocument] = useState('');
	const [fileNote, setFileNote] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [inserting, setInserting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ExtractResult | null>(null);
	const [rows, setRows] = useState<ExtractedRow[]>([]);

	const shown = columns.filter((column) => rows.some((row) => column.key in row.values || column.key in row.issues));

	useEffect(() => {
		if (open) return;
		setDocument('');
		setFileNote(null);
		setResult(null);
		setRows([]);
		setError(null);
	}, [open]);

	async function readFile(event: ChangeEvent<HTMLInputElement>) {
		const file = event.currentTarget.files?.[0];
		if (!file) return;
		if (/pdf|image/.test(file.type)) {
			setFileNote(`Mock AI can’t read ${file.type.includes('pdf') ? 'PDFs' : 'images'}. Paste the document’s text, or try a sample.`);
			return;
		}
		setFileNote(`Loaded ${file.name}.`);
		setDocument(await file.text());
	}

	async function extract() {
		if (!document.trim()) return;
		setRunning(true);
		setError(null);
		try {
			const outcome = await runAiActivity('import', sheet.name, () => ai.extractRows(document, columns), (o) => `${o.rows.length} rows extracted`);
			setResult(outcome);
			setRows(outcome.rows.map((row) => ({ values: { ...row.values }, issues: { ...row.issues } })));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	function updateCell(index: number, key: string, value: string) {
		setRows((current) =>
			current.map((row, i) => {
				if (i !== index) return row;
				const issues = { ...row.issues };
				delete issues[key];
				return { ...row, values: { ...row.values, [key]: value }, issues };
			})
		);
	}

	/** Parsed rows, or the first cell that can't be read. */
	const parsed: { data: Record<string, CellValue>[]; problem: string | null } = (() => {
		const data: Record<string, CellValue>[] = [];
		for (const [index, row] of rows.entries()) {
			const values: Record<string, CellValue> = {};
			for (const column of shown) {
				const raw = row.values[column.key]?.trim() ?? '';
				if (!raw) continue;
				const outcome = parseCellInput(column, raw);
				if (!outcome.ok) return { data: [], problem: `Row ${index + 1}, ${column.name}: ${outcome.reason}` };
				values[column.key] = outcome.value;
			}
			if (Object.keys(values).length > 0) data.push(values);
		}
		return { data, problem: null };
	})();

	async function insert() {
		if (parsed.problem || parsed.data.length === 0) return;
		setInserting(true);
		try {
			const count = parsed.data.length;
			await editor.insertRowsWithValues(parsed.data, `AI: Import ${count} ${count === 1 ? 'row' : 'rows'}`);
			onOpenChange(false);
			onApplied(`Imported ${count} ${count === 1 ? 'row' : 'rows'} at the end of the sheet`);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setInserting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<div className="flex items-center gap-2">
						<DialogTitle>Import from document</DialogTitle>
						<MockAiBadge />
					</div>
					<DialogDescription>Paste an invoice, email or table, or load a text file. Review the rows before they’re added to “{sheet.name}”.</DialogDescription>
				</DialogHeader>

				{!result ? (
					<div className="grid gap-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-xs text-muted-foreground">Try a sample:</span>
							{SAMPLE_DOCUMENTS.map((sample) => (
								<Button
									key={sample.id}
									type="button"
									size="xs"
									variant="outline"
									onClick={() => {
										setDocument(sample.text);
										setFileNote(null);
									}}
								>
									{sample.label}
								</Button>
							))}
						</div>
						<Label htmlFor="import-document">Document text</Label>
						<Textarea
							id="import-document"
							value={document}
							onChange={(event) => setDocument(event.target.value)}
							rows={12}
							className="font-mono text-xs"
							placeholder={'Supplier: Acme Ltd\nInvoice No: AC-1100\nDue date: 2026-10-01\nAmount due: $1,200.00'}
						/>
						<div className="flex flex-wrap items-center gap-3">
							<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted">
								<Upload className="size-3.5" />
								Load a file
								<input type="file" id="import-file" className="sr-only" accept=".txt,.csv,.tsv,.eml,.md,.pdf,image/*" onChange={readFile} />
							</label>
							{fileNote && <span className="text-xs text-muted-foreground">{fileNote}</span>}
						</div>
					</div>
				) : (
					<div className="grid gap-3">
						{result.notes.map((note) => (
							<p key={note} className="text-xs text-muted-foreground">
								{note}
							</p>
						))}
						{result.unmapped.length > 0 && <p className="text-xs text-muted-foreground">Not imported (no matching column): {result.unmapped.join(', ')}</p>}

						{rows.length === 0 ? (
							<p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">No rows found. Go back and paste a table or “Label: value” lines.</p>
						) : (
							<div className="overflow-x-auto rounded-lg border">
								<table className="w-full text-xs">
									<thead className="bg-muted/50 text-left text-muted-foreground">
										<tr>
											{shown.map((column) => (
												<th key={column.key} className="px-2 py-1.5 font-medium whitespace-nowrap">
													{column.name}
												</th>
											))}
											<th className="w-8">
												<span className="sr-only">Remove</span>
											</th>
										</tr>
									</thead>
									<tbody className="divide-y">
										{rows.map((row, index) => (
											<tr key={index} className="align-top">
												{shown.map((column) => {
													const issue = row.issues[column.key];
													return (
														<td key={column.key} className="min-w-32 px-2 py-1.5">
															<Input
																id={`import-${index}-${column.key}`}
																value={row.values[column.key] ?? ''}
																onChange={(event) => updateCell(index, column.key, event.target.value)}
																className={cn('h-7 text-xs', issue && 'border-amber-400 bg-amber-50/60')}
																aria-invalid={!!issue}
																title={issue}
															/>
															{issue && <p className="mt-1 text-[11px] leading-snug text-amber-800">{issue}</p>}
														</td>
													);
												})}
												<td className="px-1 py-1.5">
													<Button
														variant="ghost"
														size="icon-xs"
														aria-label={`Remove row ${index + 1}`}
														onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
													>
														<Trash2 className="size-3.5" />
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{parsed.problem && <p className="text-xs text-red-600">{parsed.problem}</p>}
					</div>
				)}

				{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

				<DialogFooter>
					{result ? (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setResult(null);
									setRows([]);
								}}
							>
								Back
							</Button>
							<Button type="button" disabled={inserting || !!parsed.problem || parsed.data.length === 0} onClick={insert}>
								{inserting ? 'Adding…' : `Add ${parsed.data.length} ${parsed.data.length === 1 ? 'row' : 'rows'}`}
							</Button>
						</>
					) : (
						<>
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="button" disabled={running || !document.trim()} onClick={extract}>
								{running ? 'Reading…' : 'Extract rows'}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
