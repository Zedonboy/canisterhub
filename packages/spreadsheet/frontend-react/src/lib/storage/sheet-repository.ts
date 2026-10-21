import type { AggregateRequest, RowQueryParams, Sheet, SheetSource } from '@/lib/types';
import { StorageNotFoundError } from './types';
import type {
	AddColumnInput,
	CellUpdate,
	ColumnUpdateInput,
	CreateSheetInput,
	InsertRowsInput,
	SheetStorageAdapter,
	WriteOptions
} from './types';

/**
 * Routes each sheet operation to the adapter that owns the sheet, and merges
 * sheet lists across adapters. New sheets go to `createSource`.
 */
export class SheetRepository {
	constructor(
		private readonly adapters: SheetStorageAdapter[],
		readonly createSource: SheetSource
	) {}

	adapterFor(sheetId: string): SheetStorageAdapter {
		const adapter = this.adapters.find((candidate) => candidate.ownsSheet(sheetId));
		if (!adapter) {
			throw new StorageNotFoundError(
				`Sheet ${sheetId} is not available: server sheets are disabled in local storage mode`
			);
		}
		return adapter;
	}

	adapterForSource(source: SheetSource): SheetStorageAdapter {
		const adapter = this.adapters.find((candidate) => candidate.source === source);
		if (!adapter) throw new Error(`No storage adapter for ${source} sheets`);
		return adapter;
	}

	get canCreateSheets(): boolean {
		return this.adapterForSource(this.createSource).capabilities.createSheets;
	}

	/**
	 * Lists sheets from every adapter whose source is in `sources` (default:
	 * all adapters). Only queried adapters are touched, so listing just
	 * `['local']` never calls the API. One unavailable adapter (e.g. the API
	 * is down) doesn't hide the others; it only errors when nothing could be listed.
	 */
	async listSheets(signal?: AbortSignal, sources?: SheetSource[]): Promise<Sheet[]> {
		const adapters = sources ? this.adapters.filter((adapter) => sources.includes(adapter.source)) : this.adapters;
		const results = await Promise.allSettled(adapters.map((adapter) => adapter.listSheets(signal)));
		// A cancelled query (superseded refetch) is not a partial failure.
		signal?.throwIfAborted();
		const sheets = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
		const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');

		if (failure && sheets.length === 0) throw failure.reason;
		if (failure) console.warn('[silver] some sheets are unavailable:', failure.reason);

		return sheets.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	}

	getSheet = (sheetId: string, signal?: AbortSignal) => this.adapterFor(sheetId).getSheet(sheetId, signal);

	listColumns = (sheetId: string, signal?: AbortSignal) => this.adapterFor(sheetId).listColumns(sheetId, signal);

	getRowPage = (sheetId: string, params: RowQueryParams, signal?: AbortSignal) =>
		this.adapterFor(sheetId).getRowPage(sheetId, params, signal);

	getRow = (sheetId: string, rowId: string, columns?: string[], signal?: AbortSignal) =>
		this.adapterFor(sheetId).getRow(sheetId, rowId, columns, signal);

	getChildren = (sheetId: string, rowId: string, columns?: string[], signal?: AbortSignal) =>
		this.adapterFor(sheetId).getChildren(sheetId, rowId, columns, signal);

	getRowsByIds = (sheetId: string, rowIds: string[], columns?: string[], signal?: AbortSignal) =>
		this.adapterFor(sheetId).getRowsByIds(sheetId, rowIds, columns, signal);

	getRange = (sheetId: string, start: number, end: number, columns: string[], signal?: AbortSignal) =>
		this.adapterFor(sheetId).getRange(sheetId, start, end, columns, signal);

	aggregate = (request: AggregateRequest, signal?: AbortSignal) =>
		this.adapterFor(request.sheetId).aggregate(request, signal);

	createSheet = (input: CreateSheetInput, source: SheetSource = this.createSource) =>
		this.adapterForSource(source).createSheet(input);

	deleteSheet = (sheetId: string) => this.adapterFor(sheetId).deleteSheet(sheetId);

	addColumn = (sheetId: string, input: AddColumnInput) => this.adapterFor(sheetId).addColumn(sheetId, input);

	columnUsage = (sheetId: string, columnKey: string) => this.adapterFor(sheetId).columnUsage(sheetId, columnKey);

	deleteColumn = (sheetId: string, columnKey: string) => this.adapterFor(sheetId).deleteColumn(sheetId, columnKey);

	updateColumn = (sheetId: string, columnKey: string, input: ColumnUpdateInput) =>
		this.adapterFor(sheetId).updateColumn(sheetId, columnKey, input);

	updateCells = (sheetId: string, updates: CellUpdate[], options?: WriteOptions) =>
		this.adapterFor(sheetId).updateCells(sheetId, updates, options);

	changeLog = (sheetId: string) => this.adapterFor(sheetId).changeLog(sheetId);

	insertRows = (sheetId: string, input: InsertRowsInput) => this.adapterFor(sheetId).insertRows(sheetId, input);

	deleteRows = (sheetId: string, rowIds: string[]) => this.adapterFor(sheetId).deleteRows(sheetId, rowIds);

	groupColumns = (sheetId: string, columnKeys: string[], name: string) =>
		this.adapterFor(sheetId).groupColumns(sheetId, columnKeys, name);

	ungroupColumns = (sheetId: string, columnKeys: string[]) =>
		this.adapterFor(sheetId).ungroupColumns(sheetId, columnKeys);

	renameColumnGroup = (sheetId: string, groupName: string, newName: string) =>
		this.adapterFor(sheetId).renameColumnGroup(sheetId, groupName, newName);

	indentRows = (sheetId: string, rowIds: string[]) => this.adapterFor(sheetId).indentRows(sheetId, rowIds);

	outdentRows = (sheetId: string, rowIds: string[]) => this.adapterFor(sheetId).outdentRows(sheetId, rowIds);

	undo = (sheetId: string) => this.adapterFor(sheetId).undo(sheetId);

	redo = (sheetId: string) => this.adapterFor(sheetId).redo(sheetId);

	historyState = (sheetId: string) => this.adapterFor(sheetId).historyState(sheetId);

	cacheFormulaValues = (sheetId: string, updates: CellUpdate[]) =>
		this.adapterFor(sheetId).cacheFormulaValues(sheetId, updates);
}
