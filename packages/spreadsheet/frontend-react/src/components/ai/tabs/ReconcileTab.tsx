import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useAiActivityStore } from '@/stores/ai-activity';
import { readRows } from '@/lib/ai/context';
import { cellNumber, cellText, formatValue, isNumericColumn } from '@/lib/ai/mock/shared';
import { ai } from '@/lib/ai/provider';
import type { ContextRow, ReconcileResult } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import { sheetRepository, type CellUpdate } from '@/lib/storage';
import type { Column, Sheet } from '@/lib/types';
import { RowChips } from '../RowChips';

interface Keys {
	amount: string;
	date: string;
	name: string;
}

const NONE = '__none__';

function defaults(list: Column[]): Keys {
	return {
		amount: list.find((column) => column.data_type === 'currency')?.key ?? list.find(isNumericColumn)?.key ?? '',
		date: list.find((column) => column.data_type === 'date')?.key ?? '',
		name: (list.find((column) => column.settings.primary) ?? list[0])?.key ?? ''
	};
}

/** Was the `columnPicker` `{#snippet}` in the Svelte original. */
function ColumnPicker({
	id,
	label,
	list,
	value,
	onChange,
	optional
}: {
	id: string;
	label: string;
	list: Column[];
	value: string;
	onChange: (key: string) => void;
	optional: boolean;
}) {
	const current = list.find((column) => column.key === value);
	return (
		<div className="grid gap-1">
			<Label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</Label>
			<Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
				<SelectTrigger id={id} className="h-8 w-full text-xs">
					{current?.name ?? (optional ? 'None' : 'Choose…')}
				</SelectTrigger>
				<SelectContent className="max-h-64">
					{optional && <SelectItem value={NONE}>None</SelectItem>}
					{list.map((column) => (
						<SelectItem key={column.key} value={column.key}>
							{column.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** Ported from components/ai/tabs/ReconcileTab.svelte. */
export function ReconcileTab({
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
	const sheetsQuery = useQuery(sheetsQueryOptions(sheet.source));
	const others = (sheetsQuery.data ?? []).filter((candidate) => candidate.id !== sheet.id);

	const [otherId, setOtherId] = useState('');
	const [otherColumns, setOtherColumns] = useState<Column[]>([]);
	const [mine, setMine] = useState<Keys>({ amount: '', date: '', name: '' });
	const [theirs, setTheirs] = useState<Keys>({ amount: '', date: '', name: '' });
	const [dayWindow, setDayWindow] = useState(3);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ReconcileResult | null>(null);
	const [leftRows, setLeftRows] = useState<ContextRow[]>([]);
	const [rightRows, setRightRows] = useState<ContextRow[]>([]);
	const [writeKey, setWriteKey] = useState('');
	const [written, setWritten] = useState(false);

	const targetColumns = columns.filter((column) => column.data_type === 'text' && !column.settings.column_formula && !column.settings.primary);

	useEffect(() => {
		setMine((current) => (current.amount || current.name ? current : defaults(columns)));
		setWriteKey((current) => current || targetColumns.find((column) => /reconcil|match/i.test(column.name))?.key || '');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [columns]);

	const other = others.find((candidate) => candidate.id === otherId);
	const leftById = new Map(leftRows.map((row) => [row.id, row]));
	const rightById = new Map(rightRows.map((row) => [row.id, row]));

	async function chooseOther(id: string) {
		setOtherId(id);
		setResult(null);
		setWritten(false);
		const nextOtherColumns = id ? await sheetRepository.listColumns(id) : [];
		setOtherColumns(nextOtherColumns);
		setTheirs(defaults(nextOtherColumns));
	}

	function describe(row: ContextRow | undefined, keys: Keys, list: Column[]): string {
		if (!row) return '—';
		const amountColumn = list.find((column) => column.key === keys.amount);
		const amount = cellNumber(row.data[keys.amount]);
		return `${cellText(row.data[keys.name]) || `Row ${row.position}`} · ${amount === null ? '' : formatValue(amount, amountColumn)}`;
	}

	async function run() {
		if (!other || !mine.amount || !theirs.amount) return;
		setRunning(true);
		setError(null);
		setWritten(false);
		try {
			const left = await readRows(sheet.id, columns, Math.min(sheet.row_count, 5_000));
			const right = await readRows(other.id, otherColumns, Math.min(other.row_count, 5_000));
			setLeftRows(left);
			setRightRows(right);
			const target = other;
			setResult(
				await runAiActivity(
					'reconcile',
					sheet.name,
					() =>
						ai.reconcile(
							{ label: sheet.name, rows: left, amountKey: mine.amount, dateKey: mine.date || null, nameKey: mine.name },
							{ label: target.name, rows: right, amountKey: theirs.amount, dateKey: theirs.date || null, nameKey: theirs.name },
							dayWindow
						),
					(outcome) => `${outcome.matches.length} matches with ${target.name}`
				)
			);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	async function writeBack() {
		if (!editor || !result || !writeKey || !other) return;
		const updates: CellUpdate[] = [
			...result.matches.map((match) => ({
				rowId: match.leftId,
				columnKey: writeKey,
				value: `Matched: ${cellText(rightById.get(match.rightId)?.data[theirs.name]) || 'row'} (${Math.round(match.score * 100)}%)`
			})),
			...result.unmatchedLeft.map((rowId) => ({ rowId, columnKey: writeKey, value: 'Unmatched' }))
		];
		try {
			const saved = await editor.setCellValues(updates, `AI: Reconcile with ${other.name}`);
			if (!saved) {
				setError(editor.lastError ?? 'The changes could not be saved.');
				return;
			}
			setWritten(true);
			onApplied(`Wrote ${updates.length} reconciliation results`);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	const link = (row: ContextRow | undefined, keys: Keys) => (row ? [{ id: row.id, position: row.position, label: cellText(row.data[keys.name]) || `Row ${row.position}` }] : []);

	const unmatchedList = (ids: string[], byId: Map<string, ContextRow>, keys: Keys, list: Column[]): ReactNode =>
		ids.length === 0 ? (
			<p className="text-xs text-muted-foreground">None</p>
		) : (
			ids.slice(0, 20).map((rowId) => (
				<p key={rowId} className="truncate text-xs">
					{describe(byId.get(rowId), keys, list)}
				</p>
			))
		);

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-0.5">
				<h3 className="text-sm font-medium">Match &amp; reconcile</h3>
				<p className="text-xs text-muted-foreground">Pairs rows in this sheet with rows in another by amount, a date window and similar names, e.g. a bank statement against the ledger.</p>
			</div>

			<div className="grid gap-1">
				<Label htmlFor="reconcile-other" className="text-xs text-muted-foreground">
					Compare with
				</Label>
				<Select value={otherId} onValueChange={(value) => void chooseOther(value)}>
					<SelectTrigger id="reconcile-other" className="h-8 w-full">
						{other?.name ?? 'Choose a sheet…'}
					</SelectTrigger>
					<SelectContent className="max-h-72">
						{others.map((candidate) => (
							<SelectItem key={candidate.id} value={candidate.id}>
								{candidate.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{other && (
				<>
					<div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
						<div className="grid gap-2">
							<p className="truncate text-xs font-medium">{sheet.name}</p>
							<ColumnPicker id="mine-amount" label="Amount" list={columns} value={mine.amount} onChange={(key) => setMine((c) => ({ ...c, amount: key }))} optional={false} />
							<ColumnPicker id="mine-date" label="Date" list={columns} value={mine.date} onChange={(key) => setMine((c) => ({ ...c, date: key }))} optional={true} />
							<ColumnPicker id="mine-name" label="Name" list={columns} value={mine.name} onChange={(key) => setMine((c) => ({ ...c, name: key }))} optional={false} />
						</div>
						<div className="grid gap-2">
							<p className="truncate text-xs font-medium">{other.name}</p>
							<ColumnPicker id="theirs-amount" label="Amount" list={otherColumns} value={theirs.amount} onChange={(key) => setTheirs((c) => ({ ...c, amount: key }))} optional={false} />
							<ColumnPicker id="theirs-date" label="Date" list={otherColumns} value={theirs.date} onChange={(key) => setTheirs((c) => ({ ...c, date: key }))} optional={true} />
							<ColumnPicker id="theirs-name" label="Name" list={otherColumns} value={theirs.name} onChange={(key) => setTheirs((c) => ({ ...c, name: key }))} optional={false} />
						</div>
					</div>
					<div className="flex items-end gap-3">
						<div className="grid gap-1">
							<Label htmlFor="reconcile-window" className="text-xs text-muted-foreground">
								Date window (days)
							</Label>
							<Input
								id="reconcile-window"
								type="number"
								min="0"
								max="30"
								value={dayWindow}
								onChange={(event) => setDayWindow(Number(event.target.value))}
								className="h-8 w-24"
							/>
						</div>
						<Button size="sm" disabled={running || !mine.amount || !theirs.amount} onClick={run}>
							<ArrowLeftRight className="size-3.5" />
							{running ? 'Matching…' : 'Find matches'}
						</Button>
					</div>
				</>
			)}

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{result && other && (
				<>
					<p className="text-sm">
						<span className="font-medium">{result.matches.length.toLocaleString()} matched</span>{' '}
						<span className="text-muted-foreground">
							· {result.unmatchedLeft.length.toLocaleString()} unmatched here · {result.unmatchedRight.length.toLocaleString()} unmatched in {other.name}
						</span>
					</p>

					{result.matches.length > 0 && (
						<ol className="grid divide-y rounded-lg border">
							{result.matches.map((match) => {
								const left = leftById.get(match.leftId);
								const right = rightById.get(match.rightId);
								return (
									<li key={match.leftId} className="grid gap-1.5 px-3 py-2">
										<div className="flex items-center gap-2 text-xs">
											<span className="min-w-0 flex-1 truncate">{describe(left, mine, columns)}</span>
											<ArrowLeftRight className="size-3 shrink-0 text-violet-600" />
											<span className="min-w-0 flex-1 truncate text-right">{describe(right, theirs, otherColumns)}</span>
											<span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 tabular-nums">{Math.round(match.score * 100)}%</span>
										</div>
										<p className="text-[11px] text-muted-foreground">{match.reasons.join(' · ')}</p>
										<RowChips rows={link(left, mine)} onRevealRow={onRevealRow} />
									</li>
								);
							})}
						</ol>
					)}

					{(result.unmatchedLeft.length > 0 || result.unmatchedRight.length > 0) && (
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="grid gap-1.5">
								<h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Unmatched here</h4>
								{unmatchedList(result.unmatchedLeft, leftById, mine, columns)}
							</div>
							<div className="grid gap-1.5">
								<h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Unmatched in {other.name}</h4>
								{unmatchedList(result.unmatchedRight, rightById, theirs, otherColumns)}
							</div>
						</div>
					)}

					{editor && targetColumns.length > 0 && (
						<div className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/50 p-3">
							<div className="min-w-40 flex-1">
								<ColumnPicker id="reconcile-write" label="Write results to column" list={targetColumns} value={writeKey} onChange={setWriteKey} optional={false} />
							</div>
							<Button size="sm" variant="outline" disabled={!writeKey || written} onClick={writeBack}>
								{written ? 'Written · undo with Ctrl+Z' : 'Write results'}
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
