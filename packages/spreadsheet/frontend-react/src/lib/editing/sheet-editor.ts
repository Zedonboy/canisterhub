import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { CachedFormulaDataResolver } from '@/lib/formulas/dependency-resolver';
import type { FormulaCellKey, FormulaRuntime } from '@/lib/formulas/formula-runtime';
import { queryKeys } from '@/lib/queries/keys';
import { sheetQueryOptions } from '@/lib/queries/sheets';
import { sheetRepository, type CellUpdate, type HistoryState, type HistoryStep } from '@/lib/storage';
import type { SheetRowStore } from '@/lib/stores/sheet-row-store';
import type { CellValue, Column, RowData } from '@/lib/types';
import { isEmptyCellValue, isFormulaCell } from '@/lib/types';
import { parseCellInput } from './cell-input';

/**
 * Ported from lib/editing/sheet-editor.svelte.ts. `$state`/`$state.raw`
 * fields (pendingWrites, lastError, lastSavedAt, history) became get/set
 * accessor pairs that call `notify()` on write — same treatment as
 * `sheet-grid-controller.ts` (Phase 5) and `sheet-search.ts` (Phase 6).
 * Internal writers (`this.pendingWrites++`, `this.lastError = ...`, etc.)
 * are untouched: `++`/`--`/plain assignment on an accessor property
 * transparently calls the getter-then-setter, so every existing call site
 * just works without modification — the only actual diff from a plain-field
 * version is the accessor declarations and `notify()`/`subscribeToChanges`/
 * `getVersion` themselves.
 */

export interface CellInput {
	rowId: string;
	columnKey: string;
	raw: string;
}

interface SheetEditorOptions {
	sheetId: string;
	queryClient: QueryClient;
	store: SheetRowStore;
	runtime: FormulaRuntime;
	resolver: CachedFormulaDataResolver;
	columns: () => Column[];
	/** Reloads columns and everything derived from them, after an undo/redo changed them. */
	onColumnsChanged: () => Promise<void>;
}

const META_REFRESH_MS = 1_000;
const VALUE_CACHE_MS = 800;
const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

/**
 * Edit commands for a writable sheet. Edits are applied optimistically to the
 * row cache, formulas recompute immediately, and the change is persisted
 * through the sheet's storage adapter, which also records it for undo.
 */
export class SheetEditor {
	private _pendingWrites = 0;
	get pendingWrites(): number {
		return this._pendingWrites;
	}
	set pendingWrites(value: number) {
		this._pendingWrites = value;
		this.notify();
	}

	private _lastError: string | null = null;
	get lastError(): string | null {
		return this._lastError;
	}
	set lastError(value: string | null) {
		this._lastError = value;
		this.notify();
	}

	private _lastSavedAt: number | null = null;
	get lastSavedAt(): number | null {
		return this._lastSavedAt;
	}
	set lastSavedAt(value: number | null) {
		this._lastSavedAt = value;
		this.notify();
	}

	/** What Undo/Redo would do; refreshed after every write. */
	private _history: HistoryState = NO_HISTORY;
	get history(): HistoryState {
		return this._history;
	}
	set history(value: HistoryState) {
		this._history = value;
		this.notify();
	}

	private listeners = new Set<() => void>();
	private version = 0;
	/** For the `useSheetEditor` React hook (useSyncExternalStore); not in the Svelte original. */
	subscribeToChanges(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Snapshot value for useSyncExternalStore — bumped on every notify(), read fields stay on the instance itself. */
	getVersion(): number {
		return this.version;
	}
	private notify() {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	private pendingValues = new Map<string, CellUpdate>();
	private valueTimer: ReturnType<typeof setTimeout> | undefined;
	private metaTimer: ReturnType<typeof setTimeout> | undefined;
	private historyQueue: Promise<unknown> = Promise.resolve();
	private readonly unsubscribe: () => void;

	constructor(private readonly options: SheetEditorOptions) {
		this.unsubscribe = options.runtime.subscribe((cells) => this.captureFormulaValues(cells));
		this.syncHistory();
	}

	dispose() {
		this.unsubscribe();
		clearTimeout(this.metaTimer);
		clearTimeout(this.valueTimer);
		void this.flushFormulaValues();
	}

	// -- Cells ------------------------------------------------------------------------

	/** Commits typed input (parsed per column type; "=..." becomes a formula). */
	setCellInputs(inputs: CellInput[]) {
		const columns = new Map(this.options.columns().map((column) => [column.key, column]));
		const rejected: string[] = [];
		const updates = inputs.flatMap((input): CellUpdate[] => {
			const column = columns.get(input.columnKey);
			if (!column) return [];
			const parsed = parseCellInput(column, input.raw);
			if (!parsed.ok) {
				rejected.push(parsed.reason);
				return [];
			}
			return [{ rowId: input.rowId, columnKey: input.columnKey, value: parsed.value }];
		});
		if (rejected.length > 0) this.lastError = rejected[0];
		return this.commit(updates);
	}

	setCellValue(rowId: string, columnKey: string, value: CellValue) {
		return this.commit([{ rowId, columnKey, value }]);
	}

	/**
	 * Writes several parsed values as one undo step, e.g. an accepted AI proposal.
	 * Resolves to false when storage rejected the write; the reason is in `lastError`.
	 */
	setCellValues(updates: CellUpdate[], label?: string): Promise<boolean> {
		return this.commit(updates, label);
	}

	clearCells(cells: FormulaCellKey[]) {
		return this.commit(cells.map((cell) => ({ ...cell, value: null })));
	}

	private async commit(requested: CellUpdate[], label?: string): Promise<boolean> {
		const { store, sheetId } = this.options;

		// Cells of a column with a column formula are calculated, never edited one by one.
		const calculated = new Map(
			this.options
				.columns()
				.filter((column) => column.settings.column_formula)
				.map((column) => [column.key, column.name])
		);
		const blocked = requested.find((update) => calculated.has(update.columnKey));
		if (blocked) {
			this.lastError = `“${calculated.get(blocked.columnKey)}” is calculated by a column formula. Change it in the column settings.`;
		}
		const updates = requested.filter((update) => !calculated.has(update.columnKey));

		const changed = updates.filter((update) => {
			const row = store.getLoadedRow(update.rowId);
			return !row || !sameValue(row.data[update.columnKey], update.value);
		});
		if (changed.length === 0) return true;

		for (const update of changed) {
			store.patchRow(update.rowId, (data) => {
				const next = { ...data };
				if (isEmptyCellValue(update.value)) delete next[update.columnKey];
				else next[update.columnKey] = update.value;
				return next;
			});
		}
		this.recalculate(changed);

		try {
			await this.write(() => sheetRepository.updateCells(sheetId, changed, { label }));
			this.scheduleMetaRefresh();
			return true;
		} catch {
			// Roll back the optimistic edit to what storage actually holds.
			await store.refresh();
			this.recalculate([]);
			return false;
		}
	}

	// -- Rows -------------------------------------------------------------------------

	async appendRows(count = 1): Promise<RowData[]> {
		const rows = await this.write(() => sheetRepository.insertRows(this.options.sheetId, { count }));
		await this.afterStructureChange();
		return rows;
	}

	async insertRowsAfter(rowId: string, count = 1): Promise<RowData[]> {
		const rows = await this.write(() => sheetRepository.insertRows(this.options.sheetId, { count, afterRowId: rowId }));
		await this.afterStructureChange();
		return rows;
	}

	async insertRowsBefore(rowId: string, count = 1): Promise<RowData[]> {
		const rows = await this.write(() => sheetRepository.insertRows(this.options.sheetId, { count, beforeRowId: rowId }));
		await this.afterStructureChange();
		return rows;
	}

	async deleteRows(rowIds: string[]) {
		if (rowIds.length === 0) return;
		await this.write(() => sheetRepository.deleteRows(this.options.sheetId, rowIds));
		await this.afterStructureChange();
	}

	/** Appends rows with values as one undo step, e.g. rows extracted from a document. */
	async insertRowsWithValues(rows: RowData['data'][], label: string): Promise<RowData[]> {
		const created = await this.write(() => sheetRepository.insertRows(this.options.sheetId, { count: rows.length, rows, label }));
		await this.afterStructureChange();
		return created;
	}

	/** Makes rows children of the row above them at the same level. */
	indentRows(rowIds: string[]) {
		return this.changeRowLevel(rowIds, 'indent');
	}

	/** Moves rows up one level; their later siblings become their children. */
	outdentRows(rowIds: string[]) {
		return this.changeRowLevel(rowIds, 'outdent');
	}

	private async changeRowLevel(rowIds: string[], direction: 'indent' | 'outdent') {
		if (rowIds.length === 0) return { moved: 0, skipped: 0 };
		const { sheetId } = this.options;
		const result = await this.write(() =>
			direction === 'indent' ? sheetRepository.indentRows(sheetId, rowIds) : sheetRepository.outdentRows(sheetId, rowIds)
		);
		if (result.moved > 0) {
			await this.afterStructureChange();
		} else {
			this.lastError =
				direction === 'indent'
					? 'Can’t indent: a row needs a row above it at the same level.'
					: 'Can’t outdent: the row is already at the top level.';
		}
		return result;
	}

	// -- History ----------------------------------------------------------------------

	/** Reverts the last change. Resolves to what changed, or null when there was nothing to undo. */
	undo(): Promise<HistoryStep | null> {
		return this.travel('undo');
	}

	/** Re-applies the last undone change. Resolves to null when there was nothing to redo. */
	redo(): Promise<HistoryStep | null> {
		return this.travel('redo');
	}

	/** Re-reads Undo/Redo availability; also needed after writes made outside the editor (column dialogs). */
	syncHistory() {
		this.history = sheetRepository.historyState(this.options.sheetId);
	}

	private travel(direction: 'undo' | 'redo'): Promise<HistoryStep | null> {
		// One step at a time, so quick repeated presses apply in order.
		const run = this.historyQueue.then(async () => {
			const { sheetId, store } = this.options;
			const step = await this.write(() => (direction === 'undo' ? sheetRepository.undo(sheetId) : sheetRepository.redo(sheetId)));
			if (!step) return null;

			if (step.columnsChanged) {
				await this.options.onColumnsChanged();
			} else if (step.structureChanged) {
				await this.afterStructureChange();
			} else {
				for (const row of step.rows) store.patchRow(row.id, () => row.data);
				this.recalculate(step.cells);
				this.scheduleMetaRefresh();
			}
			return step;
		});
		this.historyQueue = run.catch(() => undefined);
		return run;
	}

	// -- Internals --------------------------------------------------------------------

	private async write<T>(operation: () => Promise<T>): Promise<T> {
		this.pendingWrites++;
		try {
			const result = await operation();
			this.lastSavedAt = Date.now();
			this.lastError = null;
			return result;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			this.pendingWrites--;
			this.syncHistory();
		}
	}

	/** Drops cached dependency data and recomputes all loaded formulas. */
	private recalculate(changed: FormulaCellKey[]) {
		const { queryClient, sheetId, resolver, runtime, store } = this.options;
		resolver.clear();
		queryClient.removeQueries({
			queryKey: queryKeys.sheet(sheetId),
			predicate: (query) => !['detail', 'columns'].includes(String(query.queryKey[2]))
		});
		runtime.invalidate(changed);
		runtime.enqueueRows([...store.rows.values()]);
	}

	private async afterStructureChange() {
		const { queryClient, sheetId, resolver, runtime, store } = this.options;
		resolver.clear();
		runtime.invalidate();
		const sheet = await queryClient.fetchQuery({ ...sheetQueryOptions(sheetId), staleTime: 0 });
		await store.applyStructureChange(sheet.row_count);
		runtime.enqueueRows([...store.rows.values()]);
		void queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
	}

	/** Sheet list / detail show row counts and "updated" times; refresh them lazily. */
	private scheduleMetaRefresh() {
		clearTimeout(this.metaTimer);
		this.metaTimer = setTimeout(() => {
			const { queryClient, sheetId } = this.options;
			void queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
			void queryClient.invalidateQueries({ queryKey: queryKeys.sheetDetail(sheetId) });
		}, META_REFRESH_MS);
	}

	/**
	 * Persists client-computed results as each formula's cached `value`, the
	 * same contract server sheets use, so aggregates and later loads see them.
	 */
	private captureFormulaValues(cells: FormulaCellKey[]) {
		const { store, runtime } = this.options;
		for (const { rowId, columnKey } of cells) {
			const cell = store.getLoadedRow(rowId)?.data[columnKey];
			if (!isFormulaCell(cell)) continue;
			const result = runtime.resultFor(rowId, columnKey, cell);
			if (!result.computed || (result.state !== 'ready' && result.state !== 'error')) continue;

			const value = result.state === 'error' ? (result.error?.code ?? null) : result.value;
			if ((cell.value ?? null) !== value) {
				this.pendingValues.set(`${rowId} ${columnKey}`, { rowId, columnKey, value });
			}
		}
		if (this.pendingValues.size === 0) return;
		clearTimeout(this.valueTimer);
		this.valueTimer = setTimeout(() => void this.flushFormulaValues(), VALUE_CACHE_MS);
	}

	private async flushFormulaValues() {
		if (this.pendingValues.size === 0) return;
		const updates = [...this.pendingValues.values()];
		this.pendingValues.clear();
		try {
			await sheetRepository.cacheFormulaValues(this.options.sheetId, updates);
		} catch (error) {
			console.warn('[silver] could not cache formula values', error);
		}
	}
}

function sameValue(a: CellValue | undefined, b: CellValue): boolean {
	if (isEmptyCellValue(a) && isEmptyCellValue(b)) return true;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** React binding, Phase 6's job (see the class-level comment above). `editor` may be null for view-only sheets. */
export function useSheetEditor(editor: SheetEditor | null): SheetEditor | null {
	useSyncExternalStore(
		(onChange) => editor?.subscribeToChanges(onChange) ?? (() => {}),
		() => editor?.getVersion() ?? 0
	);
	return editor;
}
