import type { QueryClient } from '@tanstack/react-query';
import { aggregateQueryOptions, childrenQueryOptions, rangeQueryOptions } from '@/lib/queries/rows';
import { sheetRepository } from '@/lib/storage';
import type {
	AggregateRequest,
	CellValue,
	RangeResult,
	RowData,
	RowDocument,
	RowsByIdsResponse
} from '@/lib/types';

/** Data access used by the formula runtime. */
export interface FormulaDataResolver {
	getCell(sheetId: string, rowId: string, columnId: string): Promise<unknown>;
	getRows(sheetId: string, rowIds: string[], columns?: string[]): Promise<RowData[]>;
	getRange(sheetId: string, start: number, end: number, columns: string[]): Promise<RangeResult>;
	getChildren(sheetId: string, rowId: string, columns?: string[]): Promise<RowData[]>;
	aggregate(request: AggregateRequest): Promise<number | null>;
}

/** Read-only view of the frontend row cache (implemented by SheetRowStore). */
export interface LoadedRowSource {
	readonly sheetId: string;
	readonly totalRows: number;
	getLoadedRow(rowId: string): RowData | undefined;
	/** `offset` is the 0-based sheet position (row number - 1). */
	getLoadedRowAt(offset: number): RowData | undefined;
	/** Direct children, or undefined when they are not all in memory. */
	getLoadedChildren(rowId: string): RowData[] | undefined;
	getRowNumber(rowId: string): number | undefined;
}

export class MissingRowError extends Error {
	constructor(readonly rowId: string) {
		super(`Row ${rowId} does not exist`);
		this.name = 'MissingRowError';
	}
}

const MAX_RANGE_REQUEST = 10_000;
const MAX_IDS_PER_REQUEST = 5_000;
const BATCH_WINDOW_MS = 4;
const EXTRA_ROW_LIMIT = 20_000;

interface PendingBatch {
	ids: Set<string>;
	columns: Set<string>;
	allColumns: boolean;
	waiters: Array<{ ids: string[]; resolve: (rows: RowData[]) => void; reject: (error: unknown) => void }>;
}

interface ExtraRow {
	row: RowData;
	/** null = full row document. */
	columns: Set<string> | null;
}

/**
 * Resolves formula dependencies cheapest-first:
 *   1. the windowed row cache (rows already loaded for the grid)
 *   2. rows previously fetched for formulas, and TanStack Query's cache
 *   3. the network — batched, so many missing dependencies become one request
 */
export class CachedFormulaDataResolver implements FormulaDataResolver {
	private extraRows = new Map<string, ExtraRow>();
	private missingRows = new Set<string>();
	private pending: PendingBatch | null = null;

	constructor(
		private readonly queryClient: QueryClient,
		private readonly rows: LoadedRowSource
	) {}

	async getCell(sheetId: string, rowId: string, columnId: string): Promise<CellValue> {
		const [row] = await this.getRows(sheetId, [rowId], [columnId]);
		if (!row) throw new MissingRowError(rowId);
		return row.data[columnId] ?? null;
	}

	async getRows(sheetId: string, rowIds: string[], columns?: string[]): Promise<RowData[]> {
		this.assertSheet(sheetId);
		const found: RowData[] = [];
		const needed: string[] = [];

		for (const id of rowIds) {
			const loaded = this.rows.getLoadedRow(id);
			if (loaded) {
				found.push(loaded);
				continue;
			}
			const extra = this.extraRows.get(id);
			if (extra && covers(extra, columns)) {
				found.push(extra.row);
				continue;
			}
			if (!this.missingRows.has(id)) needed.push(id);
		}

		if (needed.length > 0) found.push(...(await this.enqueueByIds(needed, columns)));
		return found;
	}

	async getRange(sheetId: string, start: number, end: number, columns: string[]): Promise<RangeResult> {
		this.assertSheet(sheetId);

		const local = this.rangeFromLoadedRows(start, end, columns);
		if (local) return local;

		if (end - start + 1 <= MAX_RANGE_REQUEST) {
			return this.queryClient.fetchQuery(rangeQueryOptions(sheetId, start, end, columns));
		}

		const chunks: Promise<RangeResult>[] = [];
		for (let chunkStart = start; chunkStart <= end; chunkStart += MAX_RANGE_REQUEST) {
			const chunkEnd = Math.min(end, chunkStart + MAX_RANGE_REQUEST - 1);
			chunks.push(this.queryClient.fetchQuery(rangeQueryOptions(sheetId, chunkStart, chunkEnd, columns)));
		}
		const results = await Promise.all(chunks);
		return {
			rows: results.flatMap((result) => result.rows),
			start,
			end,
			total_rows: results[0]?.total_rows ?? this.rows.totalRows,
			missing_columns: results[0]?.missing_columns ?? []
		};
	}

	async getChildren(sheetId: string, rowId: string, columns?: string[]): Promise<RowData[]> {
		this.assertSheet(sheetId);
		const local = this.rows.getLoadedChildren(rowId);
		if (local) return local;

		const children = await this.queryClient.fetchQuery(childrenQueryOptions(sheetId, rowId, columns ?? []));
		// Full child rows also satisfy later lookups (e.g. nested child formulas)
		// without a by-ids round trip.
		if (!columns) children.forEach((child) => this.rememberRow(child));
		return children;
	}

	async aggregate(request: AggregateRequest): Promise<number | null> {
		this.assertSheet(request.sheetId);
		const response = await this.queryClient.fetchQuery(aggregateQueryOptions(request));
		return response.value;
	}

	isKnownMissing(rowId: string): boolean {
		return this.missingRows.has(rowId);
	}

	clear() {
		this.extraRows.clear();
		this.missingRows.clear();
	}

	// ---------------------------------------------------------------------------

	private assertSheet(sheetId: string) {
		if (sheetId !== this.rows.sheetId) {
			throw new Error(`Cross-sheet references are not supported yet (${sheetId})`);
		}
	}

	private rangeFromLoadedRows(start: number, end: number, columns: string[]): RangeResult | null {
		const total = this.rows.totalRows;
		const last = Math.min(end, total);
		const rows: RangeResult['rows'] = [];

		for (let rowNumber = start; rowNumber <= last; rowNumber++) {
			const row = this.rows.getLoadedRowAt(rowNumber - 1);
			if (!row) return null;
			rows.push({ row_id: row.id, row_number: rowNumber, values: project(row.data, columns) });
		}
		return { rows, start, end, total_rows: total, missing_columns: [] };
	}

	private enqueueByIds(ids: string[], columns?: string[]): Promise<RowData[]> {
		return new Promise((resolve, reject) => {
			if (!this.pending) {
				this.pending = { ids: new Set(), columns: new Set(), allColumns: false, waiters: [] };
				setTimeout(() => void this.flushByIds(), BATCH_WINDOW_MS);
			}
			const batch = this.pending;
			ids.forEach((id) => batch.ids.add(id));
			if (columns) columns.forEach((column) => batch.columns.add(column));
			else batch.allColumns = true;
			batch.waiters.push({ ids, resolve, reject });
		});
	}

	private async flushByIds() {
		const batch = this.pending;
		this.pending = null;
		if (!batch) return;

		const ids = [...batch.ids];
		const columns = batch.allColumns ? undefined : [...batch.columns];

		try {
			const requests: Promise<RowsByIdsResponse>[] = [];
			for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
				requests.push(
					sheetRepository.getRowsByIds(this.rows.sheetId, ids.slice(i, i + MAX_IDS_PER_REQUEST), columns)
				);
			}

			const byId = new Map<string, RowData>();
			for (const response of await Promise.all(requests)) {
				response.missing.forEach((id) => this.missingRows.add(id));
				for (const row of response.rows) {
					byId.set(row.id, this.rememberRow(row, columns));
				}
			}

			for (const waiter of batch.waiters) {
				waiter.resolve(waiter.ids.map((id) => byId.get(id)).filter((row): row is RowData => !!row));
			}
		} catch (error) {
			batch.waiters.forEach((waiter) => waiter.reject(error));
		}
	}

	/** Merges projected fetches so later lookups for other columns can hit. */
	private rememberRow(row: RowData, columns?: string[]): RowData {
		const existing = this.extraRows.get(row.id);
		if (existing && existing.columns !== null && columns) {
			const merged: RowData = { ...row, data: { ...existing.row.data, ...row.data } };
			const mergedColumns = new Set([...existing.columns, ...columns]);
			this.extraRows.set(row.id, { row: merged, columns: mergedColumns });
			return merged;
		}

		if (this.extraRows.size >= EXTRA_ROW_LIMIT) {
			this.extraRows.delete(this.extraRows.keys().next().value!);
		}
		this.extraRows.set(row.id, { row, columns: columns ? new Set(columns) : null });
		return row;
	}
}

function covers(extra: ExtraRow, columns?: string[]): boolean {
	if (extra.columns === null) return true;
	if (!columns) return false;
	return columns.every((column) => extra.columns!.has(column));
}

function project(data: RowDocument, columns: string[]): RowDocument {
	const values: RowDocument = {};
	for (const column of columns) {
		if (column in data) values[column] = data[column];
	}
	return values;
}
