import {
	icpAddColumn,
	icpAvailable,
	icpCreateSheet,
	icpDeleteColumn,
	icpDeleteRows,
	icpDeleteSheet,
	icpGetSheet,
	icpInsertRows,
	icpListColumns,
	icpListRows,
	icpListSheets,
	icpUpdateCells,
	icpUpdateColumn,
	type IcpColumn,
	type IcpInsertPosition,
	type IcpNewColumn,
	type IcpRow,
	type IcpRowDataUpdate,
	type IcpSheet
} from '@/lib/api/icp';
import { convertCellValue, formulaReferencesColumn, renameFormulaReferences } from '@/lib/editing/column-conversion';
import type {
	AggregateRequest,
	AggregateResponse,
	CellPrimitive,
	Column,
	RangeResult,
	RowData,
	RowDetail,
	RowDocument,
	RowFilterClause,
	RowPage,
	RowQueryParams,
	RowsByIdsResponse,
	Sheet
} from '@/lib/types';
import { cellPrimitive, isEmptyCellValue, isFormulaCell } from '@/lib/types';
import { buildColumns, newId, nextColumnSettings, uniqueColumnKey, validateColumnUpdate, validateCreateSheetInput, validateNewColumn } from './sheet-schema';
import {
	ICP_SHEET_PREFIX,
	StorageNotFoundError,
	StorageValidationError,
	type AddColumnInput,
	type CellUpdate,
	type ColumnDeleteResult,
	type ColumnUpdateInput,
	type ColumnUpdateResult,
	type ColumnUsage,
	type CreateSheetInput,
	type HistoryState,
	type HistoryStep,
	type InsertRowsInput,
	type RowHierarchyResult,
	type SheetChangeEntry,
	type SheetStorageAdapter,
	type WriteOptions
} from './types';

/** Rows accepted per `insertRows` call (mirrors the local adapter's cap). */
const MAX_INSERT = 500;

const toSheet = (sheet: IcpSheet): Sheet => ({
	id: sheet.id,
	name: sheet.name,
	description: sheet.description,
	row_count: sheet.row_count,
	column_count: sheet.column_count,
	created_at: sheet.created_at,
	updated_at: sheet.updated_at,
	source: 'icp',
	writable: true
});

const toColumn = (column: IcpColumn): Column => ({
	id: column.id,
	key: column.key,
	name: column.name,
	data_type: column.data_type,
	position: column.position,
	settings: parseJson(column.settings_json)
});

const toIcpNewColumn = (column: Column): IcpNewColumn => ({
	id: column.id,
	key: column.key,
	name: column.name,
	data_type: column.data_type,
	settings_json: JSON.stringify(column.settings)
});

/** Every row is flat in this tier: no `parent_id`, no children, depth 0. */
function toRowData(row: IcpRow, index: number): RowData {
	return { id: row.id, parent_id: null, position: index + 1, depth: 0, has_children: false, data: parseJson(row.data_json) };
}

function parseJson<T>(json: string): T {
	try {
		return json ? (JSON.parse(json) as T) : ({} as T);
	} catch {
		return {} as T;
	}
}

function project(data: RowDocument, columns?: string[]): RowDocument {
	if (!columns?.length) return data;
	const values: RowDocument = {};
	for (const key of columns) if (key in data) values[key] = data[key];
	return values;
}

function compareValues(a: CellPrimitive, b: CellPrimitive): number {
	if (a === b) return 0;
	if (a === null || a === '') return 1;
	if (b === null || b === '') return -1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function matchesFilter(data: RowDocument, clause: RowFilterClause): boolean {
	const value = cellPrimitive(data[clause.column]);
	const empty = value === null || value === '';
	switch (clause.op) {
		case 'eq':
			return value === clause.value;
		case 'neq':
			return value !== clause.value;
		case 'contains':
			return !empty && String(value).toLowerCase().includes(String(clause.value ?? '').toLowerCase());
		case 'gt':
			return typeof value === 'number' && value > Number(clause.value);
		case 'gte':
			return typeof value === 'number' && value >= Number(clause.value);
		case 'lt':
			return typeof value === 'number' && value < Number(clause.value);
		case 'lte':
			return typeof value === 'number' && value <= Number(clause.value);
		case 'is_empty':
			return empty;
		case 'not_empty':
			return !empty;
	}
}

/** Deep copy for JSON-shaped sheet data (mirrors the local adapter's `jsonClone`). */
function jsonClone<T>(value: T): T {
	return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Adapter for sheets stored on the `icp_backend` canister. Implements the
 * same read semantics as the browser-local adapter (pagination, projection,
 * ranges, aggregates) by fetching a sheet's rows and computing them here —
 * see `frontend/src/lib/api/icp.ts` and `icp_backend/src/lib.rs` for why:
 * the canister is deliberately just a JSON-blob store.
 *
 * Not supported in this tier: nested/indented rows, column grouping, and
 * undo/redo/change history (the canister has no notion of any of them; see
 * the "Not supported" section below). A sheet's rows are always flat.
 */
export class IcpSheetAdapter implements SheetStorageAdapter {
	readonly source = 'icp' as const;
	readonly capabilities = { createSheets: true, editCells: true, editRows: true };

	ownsSheet(sheetId: string) {
		return sheetId.startsWith(ICP_SHEET_PREFIX);
	}

	// -- Reads --------------------------------------------------------------------

	async listSheets(): Promise<Sheet[]> {
		// Listing (not a specific sheet) degrades to "no ICP sheets" when this
		// deployment has no canister configured, rather than erroring the whole
		// sheet list — see SheetRepository.listSheets.
		if (!icpAvailable()) return [];
		return (await icpListSheets()).map(toSheet);
	}

	async getSheet(sheetId: string): Promise<Sheet> {
		return toSheet(await icpGetSheet(sheetId));
	}

	async listColumns(sheetId: string): Promise<Column[]> {
		return (await icpListColumns(sheetId)).map(toColumn).sort((a, b) => a.position - b.position);
	}

	private async loadRows(sheetId: string): Promise<RowData[]> {
		return (await icpListRows(sheetId)).map(toRowData);
	}

	async getRowPage(sheetId: string, params: RowQueryParams): Promise<RowPage> {
		const rows = await this.loadRows(sheetId);
		let entries = rows.map((row, i) => ({ row, i }));

		if (params.search) {
			const needle = params.search.toLowerCase();
			entries = entries.filter((entry) => JSON.stringify(entry.row.data).toLowerCase().includes(needle));
		}
		for (const clause of params.filter ?? []) {
			entries = entries.filter((entry) => matchesFilter(entry.row.data, clause));
		}
		if (params.sort) {
			const { column, direction } = params.sort;
			const sign = direction === 'desc' ? -1 : 1;
			entries = [...entries].sort(
				(a, b) => compareValues(cellPrimitive(a.row.data[column]), cellPrimitive(b.row.data[column])) * sign || a.i - b.i
			);
		}

		return {
			rows: entries
				.slice(params.offset, params.offset + params.limit)
				.map((entry) => ({ ...entry.row, data: project(entry.row.data, params.columns) })),
			offset: params.offset,
			limit: params.limit,
			total: params.includeTotal ? entries.length : null
		};
	}

	async getRow(sheetId: string, rowId: string, columns?: string[]): Promise<RowDetail> {
		const rows = await this.loadRows(sheetId);
		const i = rows.findIndex((row) => row.id === rowId);
		if (i < 0) throw new StorageNotFoundError(`Row ${rowId} not found`);
		return { ...rows[i], data: project(rows[i].data, columns), row_number: i + 1, child_count: 0, descendant_count: 0 };
	}

	/** Rows never nest in this tier, so no row has children. */
	async getChildren(): Promise<RowData[]> {
		return [];
	}

	async getRowsByIds(sheetId: string, rowIds: string[], columns?: string[]): Promise<RowsByIdsResponse> {
		const rows = await this.loadRows(sheetId);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const found: RowData[] = [];
		const missing: string[] = [];
		for (const id of new Set(rowIds)) {
			const row = byId.get(id);
			if (!row) missing.push(id);
			else found.push({ ...row, data: project(row.data, columns) });
		}
		return { rows: found.sort((a, b) => a.position - b.position), missing };
	}

	async getRange(sheetId: string, start: number, end: number, columns: string[]): Promise<RangeResult> {
		if (start < 1 || end < start) throw new Error('`start` must be >= 1 and `end` must be >= `start`');
		const [sheetColumns, rows] = await Promise.all([this.listColumns(sheetId), this.loadRows(sheetId)]);
		const keys = new Set(sheetColumns.map((column) => column.key));
		return {
			rows: rows.slice(start - 1, end).map((row, k) => ({ row_id: row.id, row_number: start + k, values: project(row.data, columns) })),
			start,
			end,
			total_rows: rows.length,
			missing_columns: columns.filter((key) => !keys.has(key))
		};
	}

	async aggregate(request: AggregateRequest): Promise<AggregateResponse> {
		const [columns, rows] = await Promise.all([this.listColumns(request.sheetId), this.loadRows(request.sheetId)]);
		if (!columns.some((column) => column.key === request.column)) {
			throw new Error(`unknown column \`${request.column}\``);
		}

		// No row ever has a parent in this tier, so a parent-scoped aggregate has nothing to sum.
		let scope = rows;
		if (request.parentId) scope = [];
		else if (request.start !== undefined && request.end !== undefined) scope = scope.slice(request.start - 1, request.end);

		const values = scope.map((row) => cellPrimitive(row.data[request.column]));
		const numbers = values.filter((value): value is number => typeof value === 'number');
		const sum = numbers.reduce((total, n) => total + n, 0);

		const value = (() => {
			switch (request.operation) {
				case 'sum':
					return sum;
				case 'count':
					return numbers.length;
				case 'counta':
					return values.filter((v) => v !== null && v !== '').length;
				case 'avg':
					return numbers.length ? sum / numbers.length : null;
				case 'min':
					return numbers.length ? Math.min(...numbers) : null;
				case 'max':
					return numbers.length ? Math.max(...numbers) : null;
			}
		})();

		return { value, row_count: scope.length };
	}

	// -- Writes ---------------------------------------------------------------------

	async createSheet(input: CreateSheetInput): Promise<Sheet> {
		const result = validateCreateSheetInput(jsonClone(input));
		if (!result.ok) throw new StorageValidationError(result.errors);

		const columns = buildColumns(result.value.columns, newId);
		const sheet = await icpCreateSheet(result.value.name, result.value.description ?? null, columns.map(toIcpNewColumn));
		return toSheet(sheet);
	}

	async deleteSheet(sheetId: string): Promise<void> {
		await icpDeleteSheet(sheetId);
	}

	async addColumn(sheetId: string, input: AddColumnInput): Promise<Column> {
		const columns = await this.listColumns(sheetId);
		const validation = validateNewColumn(columns, jsonClone(input));
		if (!validation.ok) {
			throw new StorageValidationError({ columns: validation.error, columnErrors: {} }, validation.error);
		}

		const settings = { ...validation.value.settings };
		if (validation.value.data_type === 'currency') settings.currency ??= 'USD';
		const column: Column = {
			id: newId(),
			key: uniqueColumnKey(validation.value.name, new Set(columns.map((existing) => existing.key))),
			name: validation.value.name,
			data_type: validation.value.data_type,
			position: 0,
			settings
		};

		const created = await icpAddColumn(sheetId, toIcpNewColumn(column), input.afterColumnKey ?? null);

		// The column starts empty, so existing rows get its formula or default value.
		const { column_formula: formula, default_value: defaultValue } = column.settings;
		if (formula || (defaultValue !== undefined && !isEmptyCellValue(defaultValue))) {
			const rows = await icpListRows(sheetId);
			const updates: IcpRowDataUpdate[] = rows.map((row) => {
				const data = parseJson<RowDocument>(row.data_json);
				data[column.key] = formula ? { formula, value: null } : jsonClone(defaultValue!);
				return { row_id: row.id, data_json: JSON.stringify(data) };
			});
			if (updates.length) await icpUpdateCells(sheetId, updates);
		}

		return toColumn(created);
	}

	async columnUsage(sheetId: string, columnKey: string): Promise<ColumnUsage> {
		const columns = await this.listColumns(sheetId);
		const column = columns.find((candidate) => candidate.key === columnKey);
		if (!column) throw new StorageNotFoundError(`Column ${columnKey} not found`);

		const rows = await icpListRows(sheetId);
		let filledCells = 0;
		let formulaReferences = 0;
		for (const row of rows) {
			const data = parseJson<RowDocument>(row.data_json);
			if (!isEmptyCellValue(data[columnKey])) filledCells++;
			for (const [key, cell] of Object.entries(data)) {
				if (key !== columnKey && isFormulaCell(cell) && formulaReferencesColumn(cell.formula, column.name)) formulaReferences++;
			}
		}
		return { filledCells, formulaReferences };
	}

	async deleteColumn(sheetId: string, columnKey: string): Promise<ColumnDeleteResult> {
		const columns = await this.listColumns(sheetId);
		const column = columns.find((candidate) => candidate.key === columnKey);
		if (!column) throw new StorageNotFoundError(`Column ${columnKey} not found`);
		if (columns.length === 1) {
			const message = 'A sheet needs at least one column';
			throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
		}

		const usage = await this.columnUsage(sheetId, columnKey);

		// The canister only drops the column's metadata; strip its key from every row's
		// data ourselves first (mirrors the local adapter's own cleanup).
		const rows = await icpListRows(sheetId);
		const updates: IcpRowDataUpdate[] = [];
		for (const row of rows) {
			const data = parseJson<RowDocument>(row.data_json);
			if (!(columnKey in data)) continue;
			delete data[columnKey];
			updates.push({ row_id: row.id, data_json: JSON.stringify(data) });
		}
		if (updates.length) await icpUpdateCells(sheetId, updates);

		const deleted = await icpDeleteColumn(sheetId, columnKey);

		if (column.settings.primary) {
			const remaining = columns.filter((candidate) => candidate.key !== columnKey);
			const first = remaining[0];
			if (first && !first.settings.primary) {
				await icpUpdateColumn(sheetId, first.key, {
					name: first.name,
					data_type: first.data_type,
					settings_json: JSON.stringify({ ...first.settings, primary: true })
				});
			}
		}

		return { column: toColumn(deleted), ...usage };
	}

	async updateColumn(sheetId: string, columnKey: string, input: ColumnUpdateInput): Promise<ColumnUpdateResult> {
		const columns = await this.listColumns(sheetId);
		const current = columns.find((candidate) => candidate.key === columnKey);
		if (!current) throw new StorageNotFoundError(`Column ${columnKey} not found`);

		const validation = validateColumnUpdate(columns, columnKey, jsonClone(input));
		if (!validation.ok) {
			throw new StorageValidationError({ columns: validation.error, columnErrors: {} }, validation.error);
		}

		const next: Column = {
			...current,
			name: validation.value.name,
			data_type: validation.value.data_type,
			settings: nextColumnSettings(current, validation.value)
		};
		const typeChanged = next.data_type !== current.data_type;
		const renamed = next.name !== current.name;
		const columnFormula = next.settings.column_formula;
		const applyFormula = !!columnFormula && (columnFormula !== current.settings.column_formula || typeChanged);

		let convertedCells = 0;
		let clearedCells = 0;
		let formulasUpdated = 0;
		let formulaCellsApplied = 0;

		const rows = await icpListRows(sheetId);
		const rowUpdates: IcpRowDataUpdate[] = [];
		for (const row of rows) {
			const data = parseJson<RowDocument>(row.data_json);
			let dirty = false;

			if (renamed) {
				for (const [key, cell] of Object.entries(data)) {
					if (!isFormulaCell(cell)) continue;
					const formula = renameFormulaReferences(cell.formula, current.name, next.name);
					if (formula === cell.formula) continue;
					data[key] = { formula, value: cell.value ?? null };
					formulasUpdated++;
					dirty = true;
				}
			}

			if (applyFormula && columnFormula) {
				const existing = data[columnKey];
				if (!(isFormulaCell(existing) && existing.formula === columnFormula)) {
					data[columnKey] = { formula: columnFormula, value: null };
					formulaCellsApplied++;
					dirty = true;
				}
			} else if (typeChanged && columnKey in data) {
				const value = data[columnKey];
				const converted = convertCellValue(value, next);
				if (converted === undefined || isEmptyCellValue(converted)) {
					if (!isEmptyCellValue(value)) clearedCells++;
					delete data[columnKey];
					dirty = true;
				} else if (JSON.stringify(converted) !== JSON.stringify(value)) {
					data[columnKey] = converted;
					convertedCells++;
					dirty = true;
				}
			}

			if (dirty) rowUpdates.push({ row_id: row.id, data_json: JSON.stringify(data) });
		}
		if (rowUpdates.length) await icpUpdateCells(sheetId, rowUpdates);

		if (renamed) {
			// Other columns' formula and default settings that reference the renamed column.
			for (const column of columns) {
				if (column.key === columnKey) continue;
				const settings = { ...column.settings };
				let changed = false;
				if (settings.column_formula) {
					const formula = renameFormulaReferences(settings.column_formula, current.name, next.name);
					changed ||= formula !== settings.column_formula;
					settings.column_formula = formula;
				}
				if (isFormulaCell(settings.default_value)) {
					const formula = renameFormulaReferences(settings.default_value.formula, current.name, next.name);
					if (formula !== settings.default_value.formula) {
						settings.default_value = { formula, value: null };
						changed = true;
					}
				}
				if (changed) {
					await icpUpdateColumn(sheetId, column.key, {
						name: column.name,
						data_type: column.data_type,
						settings_json: JSON.stringify(settings)
					});
				}
			}
		}

		const updated = await icpUpdateColumn(sheetId, columnKey, {
			name: next.name,
			data_type: next.data_type,
			settings_json: JSON.stringify(next.settings)
		});

		return { column: toColumn(updated), convertedCells, clearedCells, formulasUpdated, formulaCellsApplied };
	}

	async updateCells(sheetId: string, updates: CellUpdate[], options?: WriteOptions): Promise<void> {
		void options; // No history to label here — see the module doc comment.
		const columns = await this.listColumns(sheetId);
		const keys = new Set(columns.map((column) => column.key));
		const calculated = new Map(columns.filter((column) => column.settings.column_formula).map((column) => [column.key, column.name]));
		for (const update of updates) {
			if (!keys.has(update.columnKey)) throw new StorageNotFoundError(`Column ${update.columnKey} not found`);
			if (calculated.has(update.columnKey)) {
				const message = `“${calculated.get(update.columnKey)}” is calculated by a column formula`;
				throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
			}
		}

		const byRow = new Map<string, CellUpdate[]>();
		for (const update of updates) {
			const list = byRow.get(update.rowId);
			if (list) list.push(update);
			else byRow.set(update.rowId, [update]);
		}

		const rows = await icpListRows(sheetId);
		const rowById = new Map(rows.map((row) => [row.id, row]));
		const rowUpdates: IcpRowDataUpdate[] = [];
		for (const [rowId, cellUpdates] of byRow) {
			const current = rowById.get(rowId);
			if (!current) throw new StorageNotFoundError(`Row ${rowId} not found`);
			const data = parseJson<RowDocument>(current.data_json);
			for (const update of cellUpdates) {
				if (isEmptyCellValue(update.value)) delete data[update.columnKey];
				else data[update.columnKey] = jsonClone(update.value);
			}
			rowUpdates.push({ row_id: rowId, data_json: JSON.stringify(data) });
		}
		if (rowUpdates.length) await icpUpdateCells(sheetId, rowUpdates);
	}

	async insertRows(sheetId: string, input: InsertRowsInput): Promise<RowData[]> {
		const provided = input.rows?.slice(0, MAX_INSERT);
		const count = provided ? provided.length : Math.min(Math.max(1, Math.floor(input.count)), MAX_INSERT);
		if (count === 0) return [];

		const columns = await this.listColumns(sheetId);
		// New rows start with each column's formula or default value.
		const template: RowDocument = {};
		for (const column of columns) {
			const { column_formula: formula, default_value: defaultValue } = column.settings;
			if (formula) template[column.key] = { formula, value: null };
			else if (defaultValue !== undefined && !isEmptyCellValue(defaultValue)) template[column.key] = jsonClone(defaultValue);
		}
		// Provided values fill editable columns only; column formulas always win.
		const writable = new Set(columns.filter((column) => !column.settings.column_formula).map((column) => column.key));

		const blobs = Array.from({ length: count }, (_, k) => {
			const overrides = provided?.[k] ?? {};
			const data: RowDocument = { ...template };
			for (const [key, value] of Object.entries(overrides)) {
				if (writable.has(key) && !isEmptyCellValue(value)) data[key] = jsonClone(value);
			}
			return JSON.stringify(data);
		});

		// Rows never nest in this tier: `beforeRowId`/`afterRowId` only place rows in the
		// flat order, never parent them (unlike the local adapter's nested rows).
		let position: IcpInsertPosition = { end: true };
		if (input.beforeRowId) {
			const rows = await this.loadRows(sheetId);
			const index = rows.findIndex((row) => row.id === input.beforeRowId);
			if (index < 0) throw new StorageNotFoundError(`Row ${input.beforeRowId} not found`);
			position = index > 0 ? { after: rows[index - 1].id } : { start: true };
		} else if (input.afterRowId) {
			position = { after: input.afterRowId };
		}

		return (await icpInsertRows(sheetId, blobs, position)).map(toRowData);
	}

	async deleteRows(sheetId: string, rowIds: string[]): Promise<void> {
		await icpDeleteRows(sheetId, rowIds);
	}

	// -- Not supported in this tier ---------------------------------------------------
	// Column grouping, nested/indented rows, and undo/redo/change history: the canister
	// is just a JSON-blob store (see icp_backend/src/lib.rs's module doc comment) and the
	// app's undo/redo lives entirely in the frontend, so there is nothing here to persist
	// or revert. These methods exist to satisfy `SheetStorageAdapter` and are all no-ops.

	async groupColumns(sheetId: string): Promise<Column[]> {
		return this.listColumns(sheetId);
	}

	async ungroupColumns(sheetId: string): Promise<Column[]> {
		return this.listColumns(sheetId);
	}

	async renameColumnGroup(sheetId: string): Promise<Column[]> {
		return this.listColumns(sheetId);
	}

	async indentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult> {
		void sheetId;
		return { moved: 0, skipped: rowIds.length };
	}

	async outdentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult> {
		void sheetId;
		return { moved: 0, skipped: rowIds.length };
	}

	async undo(): Promise<HistoryStep | null> {
		return null;
	}

	async redo(): Promise<HistoryStep | null> {
		return null;
	}

	historyState(): HistoryState {
		return { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
	}

	changeLog(): SheetChangeEntry[] {
		return [];
	}

	async cacheFormulaValues(): Promise<void> {
		// Optional optimization only; formulas are simply recomputed on next load.
	}
}
