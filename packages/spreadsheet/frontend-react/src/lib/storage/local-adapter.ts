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
import {
	convertCellValue,
	formulaReferencesColumn,
	renameFormulaReferences
} from '@/lib/editing/column-conversion';
import {
	buildColumns,
	newId,
	nextColumnSettings,
	uniqueColumnKey,
	validateColumnGroupName,
	validateColumnUpdate,
	validateCreateSheetInput,
	validateNewColumn
} from './sheet-schema';
import {
	LOCAL_SHEET_PREFIX,
	StorageNotFoundError,
	StorageQuotaError,
	StorageValidationError,
	type AddColumnInput,
	type CellUpdate,
	type ColumnDeleteResult,
	type ColumnUsage,
	type ColumnUpdateInput,
	type ColumnUpdateResult,
	type CreateSheetInput,
	type HistoryState,
	type HistoryStep,
	type InsertRowsInput,
	type RowHierarchyResult,
	type SheetChangeEntry,
	type SheetStorageAdapter,
	type WriteOptions
} from './types';

const INDEX_KEY = 'silver:local-sheets:index';
const sheetKey = (sheetId: string) => `silver:local-sheets:${sheetId}`;
const MAX_INSERT = 500;
/** Undo steps kept per sheet (in memory, for this page session). */
const MAX_HISTORY = 100;
/** Change log entries kept per sheet in localStorage. */
const MAX_CHANGE_LOG = 200;
const changeLogKey = (sheetId: string) => `silver:local-sheets:${sheetId}:changes`;

/**
 * Stored rows are treated as immutable: writes replace a row object rather
 * than mutating it, so history entries can keep references to earlier versions.
 */
interface StoredRow {
	id: string;
	parent_id: string | null;
	data: RowDocument;
}

/** One localStorage entry per sheet. Row order in `rows` is display order. */
interface LocalSheetDocument {
	version: 1;
	id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
	columns: Column[];
	rows: StoredRow[];
}

type IndexEntry = Omit<Sheet, 'source' | 'writable'>;

interface RowIndex {
	position: Map<string, number>;
	depth: number[];
	childCount: Map<string, number>;
}

interface RowSlot {
	index: number;
	row: StoredRow;
}

/**
 * A recorded write: enough to move the document between its state before and
 * after. No write reorders surviving rows, so slots plus replacements are exact.
 */
interface DocumentChange {
	label: string;
	/** Rows the write removed, at their index before it (ascending). */
	removed: RowSlot[];
	/** Rows the write added, at their index after it (ascending). */
	added: RowSlot[];
	changed: Array<{ before: StoredRow; after: StoredRow }>;
	/** Column lists, only when the write changed columns. */
	columns: { before: Column[]; after: Column[] } | null;
}

interface SheetHistory {
	undo: DocumentChange[];
	redo: DocumentChange[];
}

/**
 * Browser-local sheet storage. Implements the same read semantics as the Rust
 * API (pagination, projection, ranges, aggregates) so the grid and formula
 * runtime cannot tell the difference, plus the write methods and undo history.
 */
export class LocalStorageSheetAdapter implements SheetStorageAdapter {
	readonly source = 'local' as const;
	readonly capabilities = { createSheets: true, editCells: true, editRows: true };

	private docs = new Map<string, LocalSheetDocument>();
	private rowIndexes = new Map<string, RowIndex>();
	private histories = new Map<string, SheetHistory>();

	constructor(private readonly storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {}

	ownsSheet(sheetId: string) {
		return sheetId.startsWith(LOCAL_SHEET_PREFIX);
	}

	// -- Reads --------------------------------------------------------------------

	async listSheets(): Promise<Sheet[]> {
		return this.readIndex().map(toSheet);
	}

	async getSheet(sheetId: string): Promise<Sheet> {
		return toSheet(summaryOf(this.load(sheetId)));
	}

	async listColumns(sheetId: string): Promise<Column[]> {
		return this.load(sheetId).columns.map((column) => ({ ...column, settings: { ...column.settings } }));
	}

	async getRowPage(sheetId: string, params: RowQueryParams): Promise<RowPage> {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		let entries = doc.rows.map((row, i) => ({ row, i }));

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
				(a, b) =>
					compareValues(cellPrimitive(a.row.data[column]), cellPrimitive(b.row.data[column])) * sign || a.i - b.i
			);
		}

		return {
			rows: entries
				.slice(params.offset, params.offset + params.limit)
				.map((entry) => toRowData(entry.row, entry.i, index, params.columns)),
			offset: params.offset,
			limit: params.limit,
			total: params.includeTotal ? entries.length : null
		};
	}

	async getRow(sheetId: string, rowId: string, columns?: string[]): Promise<RowDetail> {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		const i = this.requireRow(doc, index, rowId);

		let descendants = 0;
		for (let j = i + 1; j < doc.rows.length && index.depth[j] > index.depth[i]; j++) descendants++;

		return {
			...toRowData(doc.rows[i], i, index, columns),
			row_number: i + 1,
			child_count: index.childCount.get(rowId) ?? 0,
			descendant_count: descendants
		};
	}

	async getChildren(sheetId: string, rowId: string, columns?: string[]): Promise<RowData[]> {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		this.requireRow(doc, index, rowId);
		return doc.rows.flatMap((row, i) => (row.parent_id === rowId ? [toRowData(row, i, index, columns)] : []));
	}

	async getRowsByIds(sheetId: string, rowIds: string[], columns?: string[]): Promise<RowsByIdsResponse> {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		const rows: RowData[] = [];
		const missing: string[] = [];
		for (const id of new Set(rowIds)) {
			const i = index.position.get(id);
			if (i === undefined) missing.push(id);
			else rows.push(toRowData(doc.rows[i], i, index, columns));
		}
		return { rows: rows.sort((a, b) => a.position - b.position), missing };
	}

	async getRange(sheetId: string, start: number, end: number, columns: string[]): Promise<RangeResult> {
		if (start < 1 || end < start) throw new Error('`start` must be >= 1 and `end` must be >= `start`');
		const doc = this.load(sheetId);
		const keys = new Set(doc.columns.map((column) => column.key));

		return {
			rows: doc.rows.slice(start - 1, end).map((row, k) => ({
				row_id: row.id,
				row_number: start + k,
				values: project(row.data, columns)
			})),
			start,
			end,
			total_rows: doc.rows.length,
			missing_columns: columns.filter((key) => !keys.has(key))
		};
	}

	async aggregate(request: AggregateRequest): Promise<AggregateResponse> {
		const doc = this.load(request.sheetId);
		if (!doc.columns.some((column) => column.key === request.column)) {
			throw new Error(`unknown column \`${request.column}\``);
		}

		let scope = doc.rows;
		if (request.parentId) scope = scope.filter((row) => row.parent_id === request.parentId);
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

		const now = new Date().toISOString();
		const doc: LocalSheetDocument = {
			version: 1,
			id: `${LOCAL_SHEET_PREFIX}${newId()}`,
			name: result.value.name,
			description: result.value.description ?? null,
			created_at: now,
			updated_at: now,
			columns: buildColumns(result.value.columns, newId),
			rows: []
		};
		this.save(doc);
		return toSheet(summaryOf(doc));
	}

	async deleteSheet(sheetId: string): Promise<void> {
		this.load(sheetId);
		this.docs.delete(sheetId);
		this.rowIndexes.delete(sheetId);
		this.histories.delete(sheetId);
		this.storage?.removeItem(sheetKey(sheetId));
		this.storage?.removeItem(changeLogKey(sheetId));
		this.writeIndex(this.readIndex().filter((entry) => entry.id !== sheetId));
	}

	async addColumn(sheetId: string, input: AddColumnInput): Promise<Column> {
		const doc = this.load(sheetId);
		const validation = validateNewColumn(doc.columns, jsonClone(input));
		if (!validation.ok) {
			throw new StorageValidationError({ columns: validation.error, columnErrors: {} }, validation.error);
		}

		const settings = { ...validation.value.settings };
		if (validation.value.data_type === 'currency') settings.currency ??= 'USD';
		const column: Column = {
			id: newId(),
			key: uniqueColumnKey(validation.value.name, new Set(doc.columns.map((existing) => existing.key))),
			name: validation.value.name,
			data_type: validation.value.data_type,
			position: 0,
			settings
		};

		return this.record(doc, `Add column “${column.name}”`, () => {
			const after = input.afterColumnKey
				? doc.columns.findIndex((existing) => existing.key === input.afterColumnKey)
				: -1;
			doc.columns.splice(after >= 0 ? after + 1 : doc.columns.length, 0, column);
			renumberColumns(doc);

			// The column starts empty, so existing rows get its formula or default value.
			const { column_formula: formula, default_value: defaultValue } = column.settings;
			if (formula || (defaultValue !== undefined && !isEmptyCellValue(defaultValue))) {
				doc.rows = doc.rows.map((row) => ({
					...row,
					data: { ...row.data, [column.key]: formula ? { formula, value: null } : jsonClone(defaultValue!) }
				}));
			}

			this.save(doc, { touch: true });
			return { ...column, settings: { ...column.settings } };
		});
	}

	async columnUsage(sheetId: string, columnKey: string): Promise<ColumnUsage> {
		const doc = this.load(sheetId);
		const column = doc.columns.find((candidate) => candidate.key === columnKey);
		if (!column) throw new StorageNotFoundError(`Column ${columnKey} not found`);
		return measureColumnUsage(doc, column);
	}

	async deleteColumn(sheetId: string, columnKey: string): Promise<ColumnDeleteResult> {
		const doc = this.load(sheetId);
		const index = doc.columns.findIndex((candidate) => candidate.key === columnKey);
		if (index < 0) throw new StorageNotFoundError(`Column ${columnKey} not found`);
		if (doc.columns.length === 1) {
			const message = 'A sheet needs at least one column';
			throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
		}

		const column = doc.columns[index];
		const usage = measureColumnUsage(doc, column);

		return this.record(doc, `Delete column “${column.name}”`, () => {
			doc.columns.splice(index, 1);
			if (column.settings.primary) {
				const [first] = doc.columns;
				doc.columns[0] = { ...first, settings: { ...first.settings, primary: true } };
			}
			renumberColumns(doc);
			doc.rows = doc.rows.map((row) => {
				if (!(columnKey in row.data)) return row;
				const data = { ...row.data };
				delete data[columnKey];
				return { ...row, data };
			});

			this.save(doc, { touch: true });
			return { column, ...usage };
		});
	}

	async updateColumn(sheetId: string, columnKey: string, input: ColumnUpdateInput): Promise<ColumnUpdateResult> {
		const doc = this.load(sheetId);
		const position = doc.columns.findIndex((column) => column.key === columnKey);
		if (position < 0) throw new StorageNotFoundError(`Column ${columnKey} not found`);
		const current = doc.columns[position];

		const validation = validateColumnUpdate(doc.columns, columnKey, jsonClone(input));
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
		// (Re)apply the column formula when it is new, changed, or the type changed.
		const applyFormula = !!columnFormula && (columnFormula !== current.settings.column_formula || typeChanged);
		let convertedCells = 0;
		let clearedCells = 0;
		let formulasUpdated = 0;
		let formulaCellsApplied = 0;

		return this.record(doc, `Edit column “${next.name}”`, () => {
			doc.rows = doc.rows.map((row) => {
				const data = { ...row.data };
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

				return dirty ? { ...row, data } : row;
			});

			if (renamed) {
				// Other columns' formula and default settings that reference the renamed column.
				doc.columns = doc.columns.map((column) => {
					if (column.key === columnKey) return column;
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
					return changed ? { ...column, settings } : column;
				});
			}

			doc.columns[position] = next;
			this.save(doc, { touch: true });
			return {
				column: { ...next, settings: { ...next.settings } },
				convertedCells,
				clearedCells,
				formulasUpdated,
				formulaCellsApplied
			};
		});
	}

	async updateCells(sheetId: string, updates: CellUpdate[], options: WriteOptions = {}): Promise<void> {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		const keys = new Set(doc.columns.map((column) => column.key));
		const calculated = new Map(
			doc.columns.filter((column) => column.settings.column_formula).map((column) => [column.key, column.name])
		);
		const verb = updates.every((update) => isEmptyCellValue(update.value)) ? 'Clear' : 'Edit';

		this.record(doc, options.label ?? `${verb} ${updates.length === 1 ? 'cell' : `${updates.length} cells`}`, () => {
			const touched = new Set<number>();
			for (const update of updates) {
				const i = this.requireRow(doc, index, update.rowId);
				if (!keys.has(update.columnKey)) throw new StorageNotFoundError(`Column ${update.columnKey} not found`);
				if (calculated.has(update.columnKey)) {
					const message = `“${calculated.get(update.columnKey)}” is calculated by a column formula`;
					throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
				}
				const row = touchRow(doc, i, touched);
				if (isEmptyCellValue(update.value)) delete row.data[update.columnKey];
				else row.data[update.columnKey] = jsonClone(update.value);
			}
			this.save(doc, { touch: true });
		});
	}

	async insertRows(sheetId: string, input: InsertRowsInput): Promise<RowData[]> {
		const provided = input.rows?.slice(0, MAX_INSERT);
		const count = provided ? provided.length : Math.min(Math.max(1, Math.floor(input.count)), MAX_INSERT);
		const doc = this.load(sheetId);
		if (count === 0) return [];
		const index = this.index(doc);

		let at = doc.rows.length;
		let parentId: string | null = null;
		if (input.beforeRowId) {
			const i = this.requireRow(doc, index, input.beforeRowId);
			at = i;
			parentId = doc.rows[i].parent_id;
		} else if (input.afterRowId) {
			const i = this.requireRow(doc, index, input.afterRowId);
			at = i + 1;
			while (at < doc.rows.length && index.depth[at] > index.depth[i]) at++;
			parentId = doc.rows[i].parent_id;
		}

		// New rows start with each column's formula or default value.
		const template: RowDocument = {};
		for (const column of doc.columns) {
			const { column_formula: formula, default_value: defaultValue } = column.settings;
			if (formula) template[column.key] = { formula, value: null };
			else if (defaultValue !== undefined && !isEmptyCellValue(defaultValue)) template[column.key] = defaultValue;
		}

		// Provided values fill editable columns only; column formulas always win.
		const writable = new Set(doc.columns.filter((column) => !column.settings.column_formula).map((column) => column.key));
		const label = input.label ?? (count === 1 ? 'Insert row' : `Insert ${count} rows`);
		return this.record(doc, label, () => {
			const created: StoredRow[] = Array.from({ length: count }, (_, k) => ({
				id: newId(),
				parent_id: parentId,
				data: { ...jsonClone(template), ...providedValues(provided?.[k], writable) }
			}));
			doc.rows.splice(at, 0, ...created);
			this.save(doc, { touch: true });

			const fresh = this.index(doc);
			return created.map((row, k) => toRowData(row, at + k, fresh));
		});
	}

	async deleteRows(sheetId: string, rowIds: string[]): Promise<void> {
		const doc = this.load(sheetId);
		this.record(doc, rowIds.length === 1 ? 'Delete row' : `Delete ${rowIds.length} rows`, () => {
			const doomed = new Set(rowIds);
			// Parents precede children, so one pass removes whole subtrees.
			for (const row of doc.rows) {
				if (row.parent_id && doomed.has(row.parent_id)) doomed.add(row.id);
			}
			doc.rows = doc.rows.filter((row) => !doomed.has(row.id));
			this.save(doc, { touch: true });
		});
	}

	async groupColumns(sheetId: string, columnKeys: string[], name: string): Promise<Column[]> {
		const doc = this.load(sheetId);
		const { value: groupName, error } = validateColumnGroupName(name);
		if (error) throw new StorageValidationError({ columns: error, columnErrors: {} }, error);

		const keys = [...new Set(columnKeys)];
		if (keys.length < 2) {
			const message = 'Select at least 2 columns to group';
			throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
		}

		const indices = keys.map((key) => doc.columns.findIndex((column) => column.key === key));
		const missing = indices.indexOf(-1);
		if (missing >= 0) throw new StorageNotFoundError(`Column ${keys[missing]} not found`);

		const sorted = [...indices].sort((a, b) => a - b);
		const contiguous = sorted.every((index, i) => i === 0 || index === sorted[i - 1] + 1);
		if (!contiguous) {
			const message = 'Select adjacent columns to group them';
			throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
		}

		return this.record(doc, `Group ${keys.length} columns as “${groupName}”`, () => {
			const targets = new Set(keys);
			doc.columns = doc.columns.map((column) =>
				targets.has(column.key) ? { ...column, settings: { ...column.settings, column_group: groupName } } : column
			);
			this.save(doc, { touch: true });
			return doc.columns.filter((column) => targets.has(column.key)).map(cloneColumn);
		});
	}

	async ungroupColumns(sheetId: string, columnKeys: string[]): Promise<Column[]> {
		const doc = this.load(sheetId);
		const keys = [...new Set(columnKeys)];
		for (const key of keys) {
			if (!doc.columns.some((column) => column.key === key)) throw new StorageNotFoundError(`Column ${key} not found`);
		}

		const label = keys.length === 1 ? 'Remove column from group' : `Ungroup ${keys.length} columns`;
		return this.record(doc, label, () => {
			const targets = new Set(keys);
			doc.columns = doc.columns.map((column) => {
				if (!targets.has(column.key) || column.settings.column_group === undefined) return column;
				const settings = { ...column.settings };
				delete settings.column_group;
				return { ...column, settings };
			});
			this.save(doc, { touch: true });
			return doc.columns.filter((column) => targets.has(column.key)).map(cloneColumn);
		});
	}

	async renameColumnGroup(sheetId: string, groupName: string, newName: string): Promise<Column[]> {
		const doc = this.load(sheetId);
		const { value: nextName, error } = validateColumnGroupName(newName);
		if (error) throw new StorageValidationError({ columns: error, columnErrors: {} }, error);

		const members = doc.columns.filter((column) => column.settings.column_group === groupName);
		if (members.length === 0) throw new StorageNotFoundError(`Group “${groupName}” not found`);
		if (nextName === groupName) return members.map(cloneColumn);

		const collides = doc.columns.some((column) => !members.includes(column) && column.settings.column_group === nextName);
		if (collides) {
			const message = `A group named “${nextName}” already exists`;
			throw new StorageValidationError({ columns: message, columnErrors: {} }, message);
		}

		return this.record(doc, `Rename group “${groupName}” to “${nextName}”`, () => {
			doc.columns = doc.columns.map((column) =>
				column.settings.column_group === groupName
					? { ...column, settings: { ...column.settings, column_group: nextName } }
					: column
			);
			this.save(doc, { touch: true });
			return doc.columns.filter((column) => column.settings.column_group === nextName).map(cloneColumn);
		});
	}

	async indentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult> {
		return this.reparentRows(sheetId, rowIds, 'Indent', (rows, i, _position, setParent) => {
			const parentId = rows[i].parent_id;
			// The previous sibling is the nearest row above with the same parent. The rows
			// in between are its descendants, so the row becomes its last child in place.
			for (let j = i - 1; j >= 0; j--) {
				if (rows[j].id === parentId) return false;
				if (rows[j].parent_id === parentId) {
					setParent(i, rows[j].id);
					return true;
				}
			}
			return false;
		});
	}

	async outdentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult> {
		return this.reparentRows(sheetId, rowIds, 'Outdent', (rows, i, position, setParent) => {
			const { id, parent_id: parentId } = rows[i];
			if (!parentId) return false;
			// Later siblings stay below the row in display order, so they become its children.
			for (let j = i + 1; j < rows.length; j++) {
				if (rows[j].parent_id === parentId) setParent(j, id);
			}
			setParent(i, rows[position.get(parentId)!].parent_id);
			return true;
		});
	}

	/**
	 * Applies `move` to the requested rows, top to bottom. Requested rows inside
	 * another requested row's subtree move with that row instead of on their own.
	 */
	private reparentRows(
		sheetId: string,
		rowIds: string[],
		verb: 'Indent' | 'Outdent',
		move: (
			rows: StoredRow[],
			i: number,
			position: Map<string, number>,
			setParent: (i: number, parentId: string | null) => void
		) => boolean
	): RowHierarchyResult {
		const doc = this.load(sheetId);
		const index = this.index(doc);
		const requested = new Set(rowIds);
		for (const rowId of requested) this.requireRow(doc, index, rowId);

		const targets: number[] = [];
		const covered = new Set<string>();
		doc.rows.forEach((row, i) => {
			if (row.parent_id && (requested.has(row.parent_id) || covered.has(row.parent_id))) covered.add(row.id);
			else if (requested.has(row.id)) targets.push(i);
		});

		const label = (result: RowHierarchyResult) => `${verb} ${result.moved === 1 ? 'row' : `${result.moved} rows`}`;
		return this.record(doc, label, () => {
			const setParent = (i: number, parentId: string | null) => {
				doc.rows[i] = { ...doc.rows[i], parent_id: parentId };
			};
			let moved = 0;
			for (const i of targets) if (move(doc.rows, i, index.position, setParent)) moved++;
			if (moved > 0) this.save(doc, { touch: true });
			return { moved, skipped: targets.length - moved };
		});
	}

	async cacheFormulaValues(sheetId: string, updates: CellUpdate[]): Promise<void> {
		const doc = this.docs.get(sheetId) ?? (this.ownsSheet(sheetId) ? this.tryLoad(sheetId) : undefined);
		if (!doc) return;
		const index = this.index(doc);
		const touched = new Set<number>();

		for (const update of updates) {
			const i = index.position.get(update.rowId);
			const cell = i === undefined ? undefined : doc.rows[i].data[update.columnKey];
			const value = update.value;
			// Cached results are scalars; formulas and lists are never cached values.
			if (i === undefined || !isFormulaCell(cell) || isFormulaCell(value) || Array.isArray(value)) continue;
			if (cell.value === value) continue;
			touchRow(doc, i, touched).data[update.columnKey] = { formula: cell.formula, value };
		}
		// Not recorded: cached results are recomputed, not something to undo.
		if (touched.size > 0) this.save(doc);
	}

	// -- History ----------------------------------------------------------------------

	async undo(sheetId: string): Promise<HistoryStep | null> {
		return this.travel(sheetId, 'undo');
	}

	async redo(sheetId: string): Promise<HistoryStep | null> {
		return this.travel(sheetId, 'redo');
	}

	historyState(sheetId: string): HistoryState {
		const history = this.histories.get(sheetId);
		const undo = history?.undo.at(-1);
		const redo = history?.redo.at(-1);
		return { canUndo: !!undo, canRedo: !!redo, undoLabel: undo?.label ?? null, redoLabel: redo?.label ?? null };
	}

	/**
	 * Runs a user write and records what it changed. If the write throws, the
	 * in-memory document is restored so a failed write leaves no trace.
	 */
	private record<T>(doc: LocalSheetDocument, label: string | ((result: T) => string), write: () => T): T {
		const rowsBefore = doc.rows.slice();
		const columnsBefore = jsonClone(doc.columns);
		let result: T;
		try {
			result = write();
		} catch (error) {
			doc.rows = rowsBefore;
			doc.columns = columnsBefore;
			this.rowIndexes.delete(doc.id);
			throw error;
		}

		const change = diffDocument(rowsBefore, columnsBefore, doc);
		if (change) {
			const history = this.historyFor(doc.id);
			const entry = { ...change, label: typeof label === 'function' ? label(result) : label };
			history.undo.push(entry);
			this.logChange(doc.id, entry, 'change');
			if (history.undo.length > MAX_HISTORY) history.undo.shift();
			history.redo = [];
		}
		return result;
	}

	private travel(sheetId: string, direction: 'undo' | 'redo'): HistoryStep | null {
		const history = this.histories.get(sheetId);
		if (!history) return null;
		const [from, to] = direction === 'undo' ? [history.undo, history.redo] : [history.redo, history.undo];
		const change = from.at(-1);
		if (!change) return null;

		const doc = this.load(sheetId);
		const { rows, columns } = doc;
		try {
			applyChange(doc, change, direction);
			this.save(doc, { touch: true });
		} catch (error) {
			doc.rows = rows;
			doc.columns = columns;
			this.rowIndexes.delete(doc.id);
			throw error;
		}

		from.pop();
		to.push(change);
		this.logChange(sheetId, change, direction);
		return historyStep(change, direction);
	}

	changeLog(sheetId: string): SheetChangeEntry[] {
		try {
			const parsed = JSON.parse(this.storage?.getItem(changeLogKey(sheetId)) ?? '[]');
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private logChange(sheetId: string, change: DocumentChange, kind: SheetChangeEntry['kind']) {
		const undo = kind === 'undo';
		const entries = this.changeLog(sheetId);
		entries.push({
			at: new Date().toISOString(),
			label: change.label,
			kind,
			rowsAdded: (undo ? change.removed : change.added).length,
			rowsRemoved: (undo ? change.added : change.removed).length,
			rowsChanged: change.changed.length,
			columnsChanged: change.columns !== null
		});
		try {
			this.storage?.setItem(changeLogKey(sheetId), JSON.stringify(entries.slice(-MAX_CHANGE_LOG)));
		} catch {
			// The change log is best-effort; the sheet itself is already saved.
		}
	}

	private historyFor(sheetId: string): SheetHistory {
		let history = this.histories.get(sheetId);
		if (!history) {
			history = { undo: [], redo: [] };
			this.histories.set(sheetId, history);
		}
		return history;
	}

	// -- Persistence ------------------------------------------------------------------

	private tryLoad(sheetId: string): LocalSheetDocument | undefined {
		try {
			return this.load(sheetId);
		} catch {
			return undefined;
		}
	}

	private load(sheetId: string): LocalSheetDocument {
		const cached = this.docs.get(sheetId);
		if (cached) return cached;

		const raw = this.ownsSheet(sheetId) ? this.storage?.getItem(sheetKey(sheetId)) : null;
		if (!raw) throw new StorageNotFoundError(`Sheet ${sheetId} not found`);

		const doc = JSON.parse(raw) as LocalSheetDocument;
		if (doc.version !== 1 || !Array.isArray(doc.rows) || !Array.isArray(doc.columns)) {
			throw new Error(`Local sheet ${sheetId} has an unsupported format`);
		}
		this.docs.set(sheetId, doc);
		return doc;
	}

	private save(doc: LocalSheetDocument, options: { touch?: boolean } = {}) {
		if (options.touch) doc.updated_at = new Date().toISOString();
		this.docs.set(doc.id, doc);
		this.rowIndexes.delete(doc.id);

		try {
			this.storage?.setItem(sheetKey(doc.id), JSON.stringify(doc));
			const entries = this.readIndex().filter((entry) => entry.id !== doc.id);
			this.writeIndex([summaryOf(doc), ...entries]);
		} catch (error) {
			if (error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)) {
				throw new StorageQuotaError();
			}
			throw error;
		}
	}

	private readIndex(): IndexEntry[] {
		try {
			const parsed = JSON.parse(this.storage?.getItem(INDEX_KEY) ?? '[]');
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private writeIndex(entries: IndexEntry[]) {
		entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
		this.storage?.setItem(INDEX_KEY, JSON.stringify(entries));
	}

	private index(doc: LocalSheetDocument): RowIndex {
		let index = this.rowIndexes.get(doc.id);
		if (index) return index;

		const position = new Map<string, number>();
		const depth: number[] = [];
		const childCount = new Map<string, number>();
		doc.rows.forEach((row, i) => {
			position.set(row.id, i);
			const parent = row.parent_id ? position.get(row.parent_id) : undefined;
			depth[i] = parent === undefined ? 0 : depth[parent] + 1;
			if (row.parent_id) childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
		});

		index = { position, depth, childCount };
		this.rowIndexes.set(doc.id, index);
		return index;
	}

	private requireRow(doc: LocalSheetDocument, index: RowIndex, rowId: string): number {
		const i = index.position.get(rowId);
		if (i === undefined) throw new StorageNotFoundError(`Row ${rowId} not found in sheet ${doc.id}`);
		return i;
	}
}

/** Replaces row `i` with a copy (once per write) so earlier versions held by history stay intact. */
function touchRow(doc: LocalSheetDocument, i: number, touched: Set<number>): StoredRow {
	if (!touched.has(i)) {
		doc.rows[i] = { ...doc.rows[i], data: { ...doc.rows[i].data } };
		touched.add(i);
	}
	return doc.rows[i];
}

function diffDocument(
	rowsBefore: StoredRow[],
	columnsBefore: Column[],
	doc: LocalSheetDocument
): Omit<DocumentChange, 'label'> | null {
	const beforeIndex = new Map(rowsBefore.map((row, i) => [row.id, i]));
	const afterIds = new Set(doc.rows.map((row) => row.id));
	const removed = rowsBefore.flatMap((row, index) => (afterIds.has(row.id) ? [] : [{ index, row }]));
	const added: RowSlot[] = [];
	const changed: DocumentChange['changed'] = [];

	doc.rows.forEach((row, index) => {
		const i = beforeIndex.get(row.id);
		if (i === undefined) added.push({ index, row });
		else if (rowsBefore[i] !== row && JSON.stringify(rowsBefore[i]) !== JSON.stringify(row)) {
			changed.push({ before: rowsBefore[i], after: row });
		}
	});

	const columnsChanged = JSON.stringify(columnsBefore) !== JSON.stringify(doc.columns);
	if (removed.length === 0 && added.length === 0 && changed.length === 0 && !columnsChanged) return null;
	return {
		removed,
		added,
		changed,
		columns: columnsChanged ? { before: columnsBefore, after: jsonClone(doc.columns) } : null
	};
}

function applyChange(doc: LocalSheetDocument, change: DocumentChange, direction: 'undo' | 'redo') {
	const undo = direction === 'undo';
	const dropped = new Set((undo ? change.added : change.removed).map((slot) => slot.row.id));
	// Replace by id: the current object may be a newer copy (e.g. with a cached formula value).
	const replacements = new Map(change.changed.map(({ before, after }) => [before.id, undo ? before : after]));

	const rows = doc.rows.filter((row) => !dropped.has(row.id)).map((row) => replacements.get(row.id) ?? row);
	// Slots are ascending, so each row lands back at its recorded index.
	for (const { index, row } of undo ? change.removed : change.added) rows.splice(Math.min(index, rows.length), 0, row);

	doc.rows = rows;
	if (change.columns) doc.columns = jsonClone(undo ? change.columns.before : change.columns.after);
}

function historyStep(change: DocumentChange, direction: 'undo' | 'redo'): HistoryStep {
	const undo = direction === 'undo';
	const columnsChanged = change.columns !== null;
	const structureChanged =
		change.added.length > 0 ||
		change.removed.length > 0 ||
		change.changed.some(({ before, after }) => before.parent_id !== after.parent_id);
	const step: HistoryStep = { label: change.label, columnsChanged, structureChanged, rows: [], cells: [] };
	// Those steps reload rows anyway; cell-only steps are patched in place.
	if (columnsChanged || structureChanged) return step;

	for (const { before, after } of change.changed) {
		const [from, to] = undo ? [after, before] : [before, after];
		for (const key of new Set([...Object.keys(from.data), ...Object.keys(to.data)])) {
			if (JSON.stringify(from.data[key]) !== JSON.stringify(to.data[key])) step.cells.push({ rowId: to.id, columnKey: key });
		}
		step.rows.push({ id: to.id, data: jsonClone(to.data) });
	}
	return step;
}

/** Copies provided values for writable columns, dropping empty ones so column defaults stay. */
function providedValues(data: RowDocument | undefined, writable: Set<string>): RowDocument {
	const values: RowDocument = {};
	for (const [key, value] of Object.entries(data ?? {})) {
		if (writable.has(key) && !isEmptyCellValue(value)) values[key] = jsonClone(value);
	}
	return values;
}

/**
 * Deep copy for JSON-shaped sheet data. Unlike structuredClone it also copies
 * reactive proxies, such as Svelte state handed over by a component.
 */
function jsonClone<T>(value: T): T {
	return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function cloneColumn(column: Column): Column {
	return { ...column, settings: { ...column.settings } };
}

function renumberColumns(doc: LocalSheetDocument) {
	doc.columns = doc.columns.map((column, index) => ({ ...column, position: index + 1 }));
}

function measureColumnUsage(doc: LocalSheetDocument, column: Column): ColumnUsage {
	let filledCells = 0;
	let formulaReferences = 0;
	for (const row of doc.rows) {
		if (!isEmptyCellValue(row.data[column.key])) filledCells++;
		for (const [key, cell] of Object.entries(row.data)) {
			if (key !== column.key && isFormulaCell(cell) && formulaReferencesColumn(cell.formula, column.name)) {
				formulaReferences++;
			}
		}
	}
	return { filledCells, formulaReferences };
}

function summaryOf(doc: LocalSheetDocument): IndexEntry {
	return {
		id: doc.id,
		name: doc.name,
		description: doc.description,
		row_count: doc.rows.length,
		column_count: doc.columns.length,
		created_at: doc.created_at,
		updated_at: doc.updated_at
	};
}

function toSheet(entry: IndexEntry): Sheet {
	return { ...entry, source: 'local', writable: true };
}

function toRowData(row: StoredRow, i: number, index: RowIndex, columns?: string[]): RowData {
	return {
		id: row.id,
		parent_id: row.parent_id,
		position: i + 1,
		depth: index.depth[i] ?? 0,
		has_children: (index.childCount.get(row.id) ?? 0) > 0,
		data: project(row.data, columns)
	};
}

function project(data: RowDocument, columns?: string[]): RowDocument {
	if (!columns?.length) return jsonClone(data);
	const values: RowDocument = {};
	for (const key of columns) if (key in data) values[key] = jsonClone(data[key]);
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
