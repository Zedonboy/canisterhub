import { useSyncExternalStore } from 'react';
import type { FormulaRuntime } from '@/lib/formulas/formula-runtime';
import { cellDisplayText } from '@/lib/grid/cell-text';
import type { Column } from '@/lib/types';
import { isFormulaCell } from '@/lib/types';
import type { SheetRowStore } from './sheet-row-store';

/**
 * Ported from lib/stores/sheet-search.svelte.ts. `$state` fields became
 * get/set accessor pairs that call `notify()` on write, same treatment as
 * `sheet-grid-controller.ts` got in Phase 5 (its header comment explains the
 * reasoning) — needed here because `query` is written directly by a
 * controlled `<Input>` (`search.query = ...`, mirroring the Svelte
 * original's `bind:value`), so a plain field wouldn't re-render on keystroke.
 */

export interface SearchMatch {
	rowId: string;
	offset: number;
	column: number;
}

const MAX_MATCHES = 5_000;

/**
 * Searches rows currently held in the frontend row cache. The rows endpoint
 * already accepts `search` for a future server-side mode.
 */
export class SheetSearch {
	constructor(
		private readonly store: SheetRowStore,
		private readonly runtime: FormulaRuntime,
		private readonly columns: () => Column[]
	) {}

	private _query = '';
	get query(): string {
		return this._query;
	}
	set query(value: string) {
		this._query = value;
		this.notify();
	}

	private _matches: SearchMatch[] = [];
	get matches(): SearchMatch[] {
		return this._matches;
	}

	private _activeIndex = 0;
	get activeIndex(): number {
		return this._activeIndex;
	}

	private _truncated = false;
	get truncated(): boolean {
		return this._truncated;
	}

	get active(): SearchMatch | undefined {
		return this._matches[this._activeIndex];
	}

	private listeners = new Set<() => void>();
	private version = 0;
	/** For the `useSheetSearch` React hook (useSyncExternalStore); not in the Svelte original. */
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

	run() {
		const needle = this._query.trim().toLowerCase();
		if (!needle) {
			this._matches = [];
			this._activeIndex = 0;
			this._truncated = false;
			this.notify();
			return;
		}

		const previous = this.active;
		const columns = this.columns();
		const found: SearchMatch[] = [];
		let truncated = false;

		outer: for (const row of this.store.rows.values()) {
			const offset = this.store.getRowOffset(row.id);
			if (offset === undefined) continue;

			for (let index = 0; index < columns.length; index++) {
				const column = columns[index];
				const value = row.data[column.key];
				if (value === undefined || value === null) continue;

				const result = isFormulaCell(value) ? this.runtime.resultFor(row.id, column.key, value) : undefined;
				if (cellDisplayText(column, value, result).toLowerCase().includes(needle)) {
					found.push({ rowId: row.id, offset, column: index });
					if (found.length >= MAX_MATCHES) {
						truncated = true;
						break outer;
					}
				}
			}
		}

		found.sort((a, b) => a.offset - b.offset || a.column - b.column);
		const keep = previous
			? found.findIndex((match) => match.rowId === previous.rowId && match.column === previous.column)
			: -1;

		this._matches = found;
		this._truncated = truncated;
		this._activeIndex = keep >= 0 ? keep : 0;
		this.notify();
	}

	next() {
		if (this._matches.length > 0) {
			this._activeIndex = (this._activeIndex + 1) % this._matches.length;
			this.notify();
		}
	}

	previous() {
		if (this._matches.length > 0) {
			this._activeIndex = (this._activeIndex - 1 + this._matches.length) % this._matches.length;
			this.notify();
		}
	}
}

/** React binding, Phase 6's job (see the class-level comment above). */
export function useSheetSearch(search: SheetSearch): SheetSearch {
	useSyncExternalStore(
		(onChange) => search.subscribeToChanges(onChange),
		() => search.getVersion()
	);
	return search;
}
