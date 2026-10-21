import type {
	AggregateRequest,
	AggregateResponse,
	CellValue,
	Column,
	ColumnDataType,
	ColumnSettings,
	RangeResult,
	RowData,
	RowDetail,
	RowPage,
	RowQueryParams,
	RowsByIdsResponse,
	Sheet,
	SheetSource
} from '@/lib/types';

/** Ids of sheets owned by the browser-local adapter start with this prefix. */
export const LOCAL_SHEET_PREFIX = 'local-';
/** Ids of sheets owned by the ICP canister adapter start with this prefix (assigned by the canister itself). */
export const ICP_SHEET_PREFIX = 'icp-';

export interface StorageCapabilities {
	createSheets: boolean;
	editCells: boolean;
	editRows: boolean;
}

export interface NewColumnInput {
	name: string;
	data_type: ColumnDataType;
	settings?: ColumnSettings;
	/**
	 * Default value as typed by the user, parsed for the column type during
	 * validation. `undefined` leaves the current default; '' or null clears it.
	 */
	defaultInput?: string | null;
}

export interface CreateSheetInput {
	name: string;
	description?: string | null;
	columns: NewColumnInput[];
}

export interface AddColumnInput extends NewColumnInput {
	/** Insert after this column; appends when omitted. */
	afterColumnKey?: string;
}

/** What deleting a column would remove, shown in the confirmation. */
export interface ColumnUsage {
	/** Rows with a non-empty value (or formula) in the column. */
	filledCells: number;
	/** Formula cells in other columns that reference the column by name. */
	formulaReferences: number;
}

export interface ColumnDeleteResult extends ColumnUsage {
	column: Column;
}

/** A column edit: new name, type and (type-specific) settings. The key never changes. */
export interface ColumnUpdateInput {
	name: string;
	data_type: ColumnDataType;
	settings?: ColumnSettings;
	defaultInput?: string | null;
}

export interface ColumnUpdateResult {
	column: Column;
	/** Cells whose stored value was converted to the new type. */
	convertedCells: number;
	/** Cells that could not be converted and were emptied. */
	clearedCells: number;
	/** Formulas whose `[Column]` references were renamed. */
	formulasUpdated: number;
	/** Cells set to the column formula (replacing their previous values). */
	formulaCellsApplied: number;
}

export interface CellUpdate {
	rowId: string;
	columnKey: string;
	/** `null` clears the cell. */
	value: CellValue;
}

export interface InsertRowsInput {
	count: number;
	/** Insert after this row (and its descendants); appends when omitted. */
	afterRowId?: string;
	/** Insert directly before this row (as its sibling). Takes precedence over `afterRowId`. */
	beforeRowId?: string;
	/** Values for the new rows, one entry per row (`count` is ignored when given). Merged over column defaults. */
	rows?: RowData['data'][];
	/** History label for this insert, e.g. "AI: Import 3 rows". */
	label?: string;
}

/** Options for a recorded write. */
export interface WriteOptions {
	/** History label shown by Undo/Redo, e.g. "AI: Clean Supplier column". */
	label?: string;
}

/**
 * Persistence boundary for sheets. The grid, formula runtime and queries only
 * talk to this interface, so the browser-local implementation can be swapped
 * for a PostgreSQL-backed one without touching the UI.
 */
export interface SheetStorageAdapter {
	readonly source: SheetSource;
	readonly capabilities: StorageCapabilities;
	ownsSheet(sheetId: string): boolean;

	// -- Reads --------------------------------------------------------------------
	listSheets(signal?: AbortSignal): Promise<Sheet[]>;
	getSheet(sheetId: string, signal?: AbortSignal): Promise<Sheet>;
	listColumns(sheetId: string, signal?: AbortSignal): Promise<Column[]>;
	getRowPage(sheetId: string, params: RowQueryParams, signal?: AbortSignal): Promise<RowPage>;
	getRow(sheetId: string, rowId: string, columns?: string[], signal?: AbortSignal): Promise<RowDetail>;
	getChildren(sheetId: string, rowId: string, columns?: string[], signal?: AbortSignal): Promise<RowData[]>;
	getRowsByIds(sheetId: string, rowIds: string[], columns?: string[], signal?: AbortSignal): Promise<RowsByIdsResponse>;
	getRange(sheetId: string, start: number, end: number, columns: string[], signal?: AbortSignal): Promise<RangeResult>;
	aggregate(request: AggregateRequest, signal?: AbortSignal): Promise<AggregateResponse>;

	// -- Writes (gated by capabilities) ------------------------------------------
	createSheet(input: CreateSheetInput): Promise<Sheet>;
	deleteSheet(sheetId: string): Promise<void>;
	addColumn(sheetId: string, input: AddColumnInput): Promise<Column>;
	columnUsage(sheetId: string, columnKey: string): Promise<ColumnUsage>;
	/** Removes a column and permanently deletes its data from every row. */
	deleteColumn(sheetId: string, columnKey: string): Promise<ColumnDeleteResult>;
	/** Renames a column and/or changes its type, converting existing values and formula references. */
	updateColumn(sheetId: string, columnKey: string, input: ColumnUpdateInput): Promise<ColumnUpdateResult>;
	updateCells(sheetId: string, updates: CellUpdate[], options?: WriteOptions): Promise<void>;
	insertRows(sheetId: string, input: InsertRowsInput): Promise<RowData[]>;
	deleteRows(sheetId: string, rowIds: string[]): Promise<void>;
	/** Groups adjacent columns under one header spanning them; overwrites any existing group membership. */
	groupColumns(sheetId: string, columnKeys: string[], name: string): Promise<Column[]>;
	/** Removes the given columns from their group (others in the group are unaffected). */
	ungroupColumns(sheetId: string, columnKeys: string[]): Promise<Column[]>;
	/** Renames a group: every column with `column_group === groupName` is updated. */
	renameColumnGroup(sheetId: string, groupName: string, newName: string): Promise<Column[]>;
	/** Makes each row the last child of the row above it at the same level. Display order is unchanged. */
	indentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult>;
	/** Moves each row up one level; its later siblings become its children. Display order is unchanged. */
	outdentRows(sheetId: string, rowIds: string[]): Promise<RowHierarchyResult>;
	/** Stores client-computed formula results as cached `value`s (not a user edit). */
	cacheFormulaValues(sheetId: string, updates: CellUpdate[]): Promise<void>;

	// -- History: the writes above are recorded per sheet; cached formula values are not --
	/** Reverts the most recent recorded change; `null` when there is nothing to undo. */
	undo(sheetId: string): Promise<HistoryStep | null>;
	/** Re-applies the most recently undone change; `null` when there is nothing to redo. */
	redo(sheetId: string): Promise<HistoryStep | null>;
	historyState(sheetId: string): HistoryState;
	/** Recorded changes for the sheet, oldest first (kept across reloads). Empty for read-only sources. */
	changeLog(sheetId: string): SheetChangeEntry[];
}

export interface RowHierarchyResult {
	/** Rows whose level changed (their descendants move with them). */
	moved: number;
	/** Rows that could not move: no row above at the same level, or already top-level. */
	skipped: number;
}

/** One recorded change, undo or redo, as kept in a sheet's change log. */
export interface SheetChangeEntry {
	at: string;
	label: string;
	kind: 'change' | 'undo' | 'redo';
	rowsAdded: number;
	rowsRemoved: number;
	rowsChanged: number;
	columnsChanged: boolean;
}

export interface HistoryState {
	canUndo: boolean;
	canRedo: boolean;
	/** The change Undo would revert, e.g. "Edit 3 cells". */
	undoLabel: string | null;
	redoLabel: string | null;
}

/** What an undo or redo changed, so the UI refreshes only what it must. */
export interface HistoryStep {
	label: string;
	/** Columns were added, removed, renamed or retyped. */
	columnsChanged: boolean;
	/** Rows were added, removed or re-parented. */
	structureChanged: boolean;
	/** For cell-only steps: rows whose cells changed, with their data after the step. */
	rows: Array<{ id: string; data: RowData['data'] }>;
	/** For cell-only steps: the cells that changed. */
	cells: Array<{ rowId: string; columnKey: string }>;
}

export class StorageCapabilityError extends Error {
	constructor(message = 'This sheet is read-only') {
		super(message);
		this.name = 'StorageCapabilityError';
	}
}

export class StorageNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StorageNotFoundError';
	}
}

export class StorageQuotaError extends Error {
	constructor() {
		super('Browser storage is full. Delete unused local sheets to free space.');
		this.name = 'StorageQuotaError';
	}
}

export interface SheetValidationErrors {
	name?: string;
	description?: string;
	columns?: string;
	/** Per-column messages, keyed by column index. */
	columnErrors: Record<number, string>;
}

export class StorageValidationError extends Error {
	constructor(
		readonly errors: SheetValidationErrors,
		message = 'Please fix the highlighted fields'
	) {
		super(message);
		this.name = 'StorageValidationError';
	}
}
