import { FormulaAssist } from '@/components/ai/FormulaAssist';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { SelectedCellInfo } from '@/lib/grid/sheet-grid-controller';
import type { Column } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FunctionReferenceDialog } from './FunctionReferenceDialog';

/** Ported from components/sheet-viewer/FormulaBar.svelte. */
export function FormulaBar({
	selected,
	columns = [],
	editable = false,
	onCommit
}: {
	selected: SelectedCellInfo | null;
	columns?: Column[];
	editable?: boolean;
	onCommit?: (raw: string) => void;
}) {
	const result = selected?.result;
	const cachedDiffers = !!result && result.computed && result.state === 'ready' && result.cachedValue !== result.value;

	const [draft, setDraft] = useState('');
	const [dirty, setDirty] = useState(false);
	const [functionsOpen, setFunctionsOpen] = useState(false);
	const selectionKey = selected ? `${selected.rowId} ${selected.columnKey} ${selected.input}` : '';

	// Reset the draft whenever a different cell is selected or its value changes.
	useEffect(() => {
		setDraft(selected?.input ?? '');
		setDirty(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectionKey]);

	function commit() {
		if (dirty && selected) onCommit?.(draft);
		setDirty(false);
	}

	function onKeydown(event: KeyboardEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		if (event.key === 'Enter') {
			event.preventDefault();
			commit();
			input.blur();
		} else if (event.key === 'Escape') {
			setDraft(selected?.input ?? '');
			setDirty(false);
			input.blur();
		}
	}

	const functionsButton = (
		<button
			type="button"
			onClick={() => setFunctionsOpen(true)}
			title="Browse formula functions"
			aria-label="Browse formula functions"
			aria-haspopup="dialog"
			className={cn(
				'shrink-0 rounded px-1 py-0.5 font-semibold italic transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
				selected?.formula || draft.startsWith('=') ? 'text-blue-600' : 'text-muted-foreground'
			)}
		>
			fx
		</button>
	);

	return (
		<>
			<FunctionReferenceDialog open={functionsOpen} onOpenChange={setFunctionsOpen} />

			<footer className="flex h-9 shrink-0 items-center gap-3 border-t bg-muted/30 px-3 text-xs">
				{selected ? (
					<>
						<span className="shrink-0 rounded border bg-background px-1.5 py-0.5 font-medium">
							{selected.columnName}
							<span className="text-muted-foreground"> · row {selected.rowNumber}</span>
						</span>

						{functionsButton}

						{!selected.secret && (selected.formula || (editable && !selected.locked)) && (
							<FormulaAssist selected={selected} columns={columns} canInsert={editable && !selected.locked} onInsert={(formula) => onCommit?.(formula)} />
						)}

						{editable && !selected.locked ? (
							<input
								type={selected.secret ? 'password' : 'text'}
								value={draft}
								onChange={(event) => {
									setDraft(event.target.value);
									setDirty(true);
								}}
								onBlur={commit}
								onKeyDown={onKeydown}
								spellCheck="false"
								placeholder="Type a value or a formula such as =[Quantity] * 2"
								aria-label="Cell value or formula"
								className={cn(
									'h-6 min-w-0 flex-1 rounded border bg-background px-2 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20',
									draft.startsWith('=') && 'font-mono text-blue-700'
								)}
							/>
						) : (
							<span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={selected.formula ?? selected.raw}>
								{selected.formula ?? selected.raw}
							</span>
						)}

						{selected.locked && (
							<span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-blue-700" title="Every cell in this column uses the column formula. Change it in the column settings.">
								Column formula
							</span>
						)}

						{result ? (
							result.state === 'error' && result.error ? (
								<>
									<span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-700">{result.error.code}</span>
									<span className="max-w-80 shrink-0 truncate text-muted-foreground" title={result.error.message}>
										{result.error.message}
									</span>
								</>
							) : result.state === 'loading-dependencies' || result.state === 'evaluating' ? (
								<span className="flex shrink-0 items-center gap-1.5 text-blue-700">
									<span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
									Loading dependencies · showing cached value
								</span>
							) : result.computed ? (
								<>
									<span className="shrink-0 font-medium">= {selected.display}</span>
									<span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">Computed in browser</span>
									{cachedDiffers && !editable && <span className="shrink-0 text-muted-foreground">cached: {result.cachedValue ?? 'none'}</span>}
								</>
							) : (
								<>
									<span className="shrink-0 font-medium">= {selected.display}</span>
									<span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">Cached value</span>
								</>
							)
						) : (
							!editable && <span className="shrink-0 font-medium">{selected.display}</span>
						)}
					</>
				) : (
					<>
						{functionsButton}
						<span className="truncate text-muted-foreground">
							{editable
								? 'Select a cell to edit it here, or double-click / start typing in the grid. Use a column header’s menu (or right-click it) to rename it or change its type.'
								: 'Select a cell to inspect its value or formula. Data is view only.'}
						</span>
					</>
				)}
			</footer>
		</>
	);
}
