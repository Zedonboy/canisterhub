import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { LoadedRowSource } from '@/lib/formulas/dependency-resolver';
import { queryKeys } from '@/lib/queries/keys';
import { ROW_BLOCK_SIZE, rowBlockQueryOptions, rowDetailQueryOptions } from '@/lib/queries/rows';
import type { RowData, RowPage, SheetRowCache } from '@/lib/types';

/**
 * Ported from lib/stores/sheet-row-store.svelte.ts. This is a per-instance
 * class (one per open sheet, constructed by SheetViewer — see the migration
 * plan's Phase 6), not a singleton, so it doesn't live under stores/ the
 * way the Zustand stores do; kept at the same lib/stores/ path as the
 * Svelte original to make that distinction obvious.
 *
 * Internals are unchanged from the Svelte version except that the `$state`/
 * `$state.raw` rune fields (totalRows, visibleRowCount, pendingBlocks,
 * collapsedCount, version, lastError) are now plain fields — this class
 * deliberately mixes a few reactive-UI-bound counters with an imperative
 * Map-based pub/sub for the high-frequency row data itself (to avoid
 * reactivity overhead on a virtualized grid). Phase 6 (see `useSheetRowStore`
 * at the bottom of this file) added the `useSyncExternalStore` React binding
 * those counters needed, now that SheetViewer actually constructs and
 * renders against one of these: `emit(...)` bumps `version` for every event,
 * including a new 'meta' kind for totalRows/pendingBlocks/lastError changes
 * that no existing event covered.
 */

export type RowStoreEvent =
	/** Rows for sheet offsets [startOffset, endOffset] arrived. */
	| { kind: 'rows'; startOffset: number; endOffset: number; rows: RowData[] }
	/** Visible row mapping changed (expand/collapse). */
	| { kind: 'structure' }
	| { kind: 'evicted'; rowIds: string[] }
	/**
	 * Phase 6 addition: totalRows, pendingBlocks or lastError changed — none
	 * of which a grid redraw cares about (no 'rows'/'structure' data moved),
	 * but SheetHeader's loading/error UI does. Exists so `useSheetRowStore`
	 * below has something to re-render on for those fields too.
	 */
	| { kind: 'meta' };

interface Block {
	index: number;
	rowIds: string[];
	lastAccess: number;
}

interface CollapsedRow {
	offset: number;
	descendants: number;
}

export interface SheetRowStoreOptions {
	blockSize?: number;
	/** Upper bound on blocks kept in memory; far-away blocks are evicted. */
	maxBlocks?: number;
	/** Extra blocks fetched before/after the viewport. */
	prefetchBlocks?: number;
}

/**
 * Windowed frontend row cache for one sheet.
 *
 * Rows are fetched in fixed blocks through TanStack Query (dedup, caching,
 * staleness) and indexed by id and by sheet offset. Collapsed hierarchy rows
 * are modelled as hidden offset intervals, so the grid's visible index maps
 * onto server offsets without loading the hidden rows.
 */
export class SheetRowStore implements LoadedRowSource {
	readonly rows: SheetRowCache = new Map();

	totalRows = 0;
	visibleRowCount = 0;
	pendingBlocks = 0;
	collapsedCount = 0;
	/** Bumped whenever rows are added or replaced. */
	version = 0;
	lastError: unknown = null;

	private offsetToId = new Map<number, string>();
	private idToOffset = new Map<string, number>();
	private blocks = new Map<number, Block>();
	private inflight = new Map<number, Promise<void>>();
	private collapsed = new Map<string, CollapsedRow>();
	private hidden: Array<[start: number, end: number]> = [];
	private listeners = new Set<(event: RowStoreEvent) => void>();
	private viewportBlocks: [number, number] = [0, 0];
	private lastVisible: [number, number] = [0, 0];
	private generation = 0;

	constructor(
		readonly sheetId: string,
		private readonly queryClient: QueryClient,
		private readonly options: SheetRowStoreOptions = {}
	) {
	}

	get blockSize() {
		return this.options.blockSize ?? ROW_BLOCK_SIZE;
	}

	get loadedRowCount() {
		return this.rows.size;
	}

	subscribe(listener: (event: RowStoreEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setTotalRows(total: number) {
		if (total === this.totalRows) return;
		this.totalRows = total;
		this.recomputeHidden();
		this.emit({ kind: 'meta' });
	}

	// -- Visible index <-> sheet offset ------------------------------------------

	visibleToOffset(visibleIndex: number): number {
		let offset = visibleIndex;
		for (const [start, end] of this.hidden) {
			if (start <= offset) offset += end - start + 1;
			else break;
		}
		return offset;
	}

	/** -1 when the offset is hidden inside a collapsed parent. */
	offsetToVisible(offset: number): number {
		let hiddenBefore = 0;
		for (const [start, end] of this.hidden) {
			if (offset < start) break;
			if (offset <= end) return -1;
			hiddenBefore += end - start + 1;
		}
		return offset - hiddenBefore;
	}

	getRowAtVisible(visibleIndex: number): RowData | undefined {
		return this.getLoadedRowAt(this.visibleToOffset(visibleIndex));
	}

	isCollapsed(rowId: string): boolean {
		return this.collapsed.has(rowId);
	}

	// -- LoadedRowSource ------------------------------------------------------------

	getLoadedRow(rowId: string): RowData | undefined {
		return this.rows.get(rowId);
	}

	getLoadedRowAt(offset: number): RowData | undefined {
		const id = this.offsetToId.get(offset);
		return id === undefined ? undefined : this.rows.get(id);
	}

	getRowOffset(rowId: string): number | undefined {
		return this.idToOffset.get(rowId);
	}

	getRowNumber(rowId: string): number | undefined {
		const offset = this.idToOffset.get(rowId);
		return offset === undefined ? undefined : offset + 1;
	}

	getLoadedChildren(rowId: string): RowData[] | undefined {
		const offset = this.idToOffset.get(rowId);
		const parent = this.rows.get(rowId);
		if (offset === undefined || !parent) return undefined;
		if (!parent.has_children) return [];

		const children: RowData[] = [];
		for (let o = offset + 1; o < this.totalRows; o++) {
			const row = this.getLoadedRowAt(o);
			if (!row) return undefined; // gap: descendants not fully in memory
			if (row.depth <= parent.depth) break;
			if (row.depth === parent.depth + 1) children.push(row);
		}
		return children;
	}

	// -- Loading -----------------------------------------------------------------------

	/** Called with the grid's visible (post-collapse) row indices. */
	ensureVisibleRange(firstVisible: number, lastVisible: number) {
		this.lastVisible = [firstVisible, lastVisible];
		if (this.totalRows === 0) return;

		const [from, to] = this.blocksFor(firstVisible, lastVisible);
		this.viewportBlocks = [from, to];

		const now = performance.now();
		for (let index = from; index <= to; index++) {
			const block = this.blocks.get(index);
			if (block) block.lastAccess = now;
			else void this.loadBlock(index);
		}
		this.evictIfNeeded();
	}

	/** Block range covering the visible rows plus prefetch margin. */
	private blocksFor(firstVisible: number, lastVisible: number): [number, number] {
		if (this.totalRows === 0) return [0, -1];
		const prefetch = this.options.prefetchBlocks ?? 1;
		const lastBlock = Math.floor((this.totalRows - 1) / this.blockSize);
		const firstOffset = Math.min(this.totalRows - 1, this.visibleToOffset(Math.max(0, firstVisible)));
		const lastOffset = Math.min(this.totalRows - 1, this.visibleToOffset(Math.max(firstVisible, lastVisible)));
		return [
			Math.min(lastBlock, Math.max(0, Math.floor(firstOffset / this.blockSize) - prefetch)),
			Math.min(lastBlock, Math.floor(lastOffset / this.blockSize) + prefetch)
		];
	}

	// -- Local edits ----------------------------------------------------------------------

	/** Applies an optimistic edit to a cached row and redraws it. */
	patchRow(rowId: string, update: (data: RowData['data']) => RowData['data']): RowData | undefined {
		const row = this.rows.get(rowId);
		const offset = this.idToOffset.get(rowId);
		if (!row || offset === undefined) return undefined;

		const next: RowData = { ...row, data: update(row.data) };
		this.rows.set(rowId, next);
		this.emit({ kind: 'rows', startOffset: offset, endOffset: offset, rows: [next] });
		return next;
	}

	/** Re-syncs after rows were inserted or deleted in storage. */
	async applyStructureChange(totalRows: number) {
		this.collapsed.clear();
		this.totalRows = totalRows;
		this.recomputeHidden();
		await this.refresh();
		this.emit({ kind: 'structure' });
	}

	private loadBlock(index: number, options: { force?: boolean } = {}): Promise<void> {
		const existing = this.inflight.get(index);
		if (existing) return existing;

		const generation = this.generation;
		const queryOptions = rowBlockQueryOptions(this.sheetId, index, this.blockSize);
		this.pendingBlocks++;
		this.emit({ kind: 'meta' });

		const promise = this.queryClient
			.fetchQuery(options.force ? { ...queryOptions, staleTime: 0 } : queryOptions)
			.then((page) => {
				if (generation === this.generation) this.ingest(index, page);
			})
			.catch((error: unknown) => {
				this.lastError = error;
				this.emit({ kind: 'meta' });
			})
			.finally(() => {
				this.pendingBlocks--;
				this.inflight.delete(index);
				this.emit({ kind: 'meta' });
			});

		this.inflight.set(index, promise);
		return promise;
	}

	private ingest(index: number, page: RowPage) {
		const start = index * this.blockSize;
		this.dropBlockRows(index);

		const rowIds = page.rows.map((row, i) => {
			const offset = start + i;
			this.rows.set(row.id, row);
			this.offsetToId.set(offset, row.id);
			this.idToOffset.set(row.id, offset);
			return row.id;
		});

		this.blocks.set(index, { index, rowIds, lastAccess: performance.now() });
		this.lastError = null;

		if (page.rows.length > 0) {
			this.emit({ kind: 'rows', startOffset: start, endOffset: start + page.rows.length - 1, rows: page.rows });
		} else {
			this.emit({ kind: 'meta' });
		}
	}

	private dropBlockRows(index: number): string[] {
		const block = this.blocks.get(index);
		const start = index * this.blockSize;
		for (let offset = start; offset < start + this.blockSize; offset++) this.offsetToId.delete(offset);
		if (!block) return [];

		for (const id of block.rowIds) {
			const offset = this.idToOffset.get(id);
			if (offset !== undefined && Math.floor(offset / this.blockSize) === index) {
				this.idToOffset.delete(id);
				this.rows.delete(id);
			}
		}
		return block.rowIds;
	}

	private evictIfNeeded() {
		const maxBlocks = this.options.maxBlocks ?? 50;
		if (this.blocks.size <= maxBlocks) return;

		const [keepFrom, keepTo] = this.viewportBlocks;
		const candidates = [...this.blocks.values()]
			.filter((block) => block.index < keepFrom || block.index > keepTo)
			.sort((a, b) => a.lastAccess - b.lastAccess);

		const evicted: string[] = [];
		while (this.blocks.size > maxBlocks && candidates.length > 0) {
			const block = candidates.shift()!;
			evicted.push(...this.dropBlockRows(block.index));
			this.blocks.delete(block.index);
		}
		if (evicted.length > 0) this.emit({ kind: 'evicted', rowIds: evicted });
	}

	// -- Hierarchy -----------------------------------------------------------------------

	async toggleCollapsed(rowId: string) {
		if (this.collapsed.delete(rowId)) {
			this.recomputeHidden();
			this.emit({ kind: 'structure' });
			return;
		}

		const row = this.rows.get(rowId);
		const offset = this.idToOffset.get(rowId);
		if (!row?.has_children || offset === undefined) return;

		const descendants =
			this.countLoadedDescendants(offset, row.depth) ??
			(await this.queryClient.fetchQuery(rowDetailQueryOptions(this.sheetId, rowId))).descendant_count;

		this.collapsed.set(rowId, { offset, descendants });
		this.recomputeHidden();
		this.emit({ kind: 'structure' });
	}

	expandAll() {
		if (this.collapsed.size === 0) return;
		this.collapsed.clear();
		this.recomputeHidden();
		this.emit({ kind: 'structure' });
	}

	private countLoadedDescendants(offset: number, depth: number): number | null {
		let count = 0;
		for (let o = offset + 1; o < this.totalRows; o++) {
			const row = this.getLoadedRowAt(o);
			if (!row) return null;
			if (row.depth <= depth) break;
			count++;
		}
		return count;
	}

	private recomputeHidden() {
		const intervals = [...this.collapsed.values()]
			.filter((row) => row.descendants > 0)
			.map((row): [number, number] => [row.offset + 1, row.offset + row.descendants])
			.sort((a, b) => a[0] - b[0]);

		const merged: Array<[number, number]> = [];
		for (const interval of intervals) {
			const last = merged.at(-1);
			if (last && interval[0] <= last[1] + 1) last[1] = Math.max(last[1], interval[1]);
			else merged.push([...interval]);
		}

		this.hidden = merged;
		const hiddenCount = merged.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
		this.visibleRowCount = Math.max(0, this.totalRows - hiddenCount);
		this.collapsedCount = this.collapsed.size;
	}

	// -- Refresh ------------------------------------------------------------------------

	/**
	 * Re-fetches the blocks around the viewport while keeping current rows on
	 * screen until replacements arrive (no blank flash). Other blocks are dropped.
	 */
	async refresh() {
		this.generation++;
		await this.queryClient.invalidateQueries({ queryKey: queryKeys.sheet(this.sheetId), refetchType: 'none' });

		const [from, to] = this.blocksFor(...this.lastVisible);
		this.viewportBlocks = [from, to];
		const evicted: string[] = [];
		for (const index of [...this.blocks.keys()]) {
			if (index < from || index > to) {
				evicted.push(...this.dropBlockRows(index));
				this.blocks.delete(index);
			}
		}
		if (evicted.length > 0) this.emit({ kind: 'evicted', rowIds: evicted });

		const reloads: Promise<void>[] = [];
		for (let index = from; index <= to; index++) reloads.push(this.loadBlock(index, { force: true }));
		await Promise.all(reloads);
	}

	/** Every emit bumps `version` — see `useSheetRowStore` for why. */
	private emit(event: RowStoreEvent) {
		this.version++;
		this.listeners.forEach((listener) => listener(event));
	}
}

/**
 * React binding, Phase 6's job per this file's header comment. `version` is
 * bumped by every `emit(...)` call (rows arriving, structure changes,
 * evictions, and the Phase-6-added 'meta' kind for totalRows/pendingBlocks/
 * lastError) — same `useSyncExternalStore`-over-a-version-counter pattern as
 * `useSheetGridController` (Phase 5). Re-renders the caller on any of those;
 * read fields straight off the returned instance.
 */
export function useSheetRowStore(store: SheetRowStore): SheetRowStore {
	useSyncExternalStore(
		(onChange) => store.subscribe(() => onChange()),
		() => store.version
	);
	return store;
}
