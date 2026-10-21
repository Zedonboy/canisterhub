export type CellPrimitive = string | number | boolean | null;

/**
 * Formula cells are stored as objects. `formula` is authoritative; `value` is
 * the last cached result (may be missing or stale).
 */
export interface FormulaCell {
	formula: string;
	value?: CellPrimitive;
}

/** One entry of a drilldown cell: a label with an optional image URL. */
export interface DrilldownItem {
	text: string;
	img?: string;
}

/** Multi-value cells: bubble tags and image URLs (strings) or drilldown items. */
export type CellList = string[] | DrilldownItem[];

export type CellValue = CellPrimitive | FormulaCell | CellList;

export type RowDocument = Record<string, CellValue>;

export interface RowData {
	id: string;
	parent_id: string | null;
	position: number;
	depth: number;
	has_children: boolean;
	data: RowDocument;
}

export interface RowDetail extends RowData {
	row_number: number;
	child_count: number;
	descendant_count: number;
}

/** Frontend row cache, indexed by row id. */
export type SheetRowCache = Map<string, RowData>;

export interface RowPage {
	rows: RowData[];
	offset: number;
	limit: number;
	total: number | null;
}

export type SortDirection = 'asc' | 'desc';

export interface RowSort {
	column: string;
	direction: SortDirection;
}

export type FilterOperator =
	| 'eq'
	| 'neq'
	| 'contains'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'is_empty'
	| 'not_empty';

export interface RowFilterClause {
	column: string;
	op: FilterOperator;
	value?: unknown;
}

export interface RowQueryParams {
	offset: number;
	limit: number;
	sort?: RowSort;
	filter?: RowFilterClause[];
	columns?: string[];
	/** Server-side search (backend placeholder; the UI searches loaded rows). */
	search?: string;
	includeTotal?: boolean;
}

export interface RowsByIdsResponse {
	rows: RowData[];
	/** Ids that do not exist in the sheet. */
	missing: string[];
}

export interface RangeRow {
	row_id: string;
	row_number: number;
	values: RowDocument;
}

export interface RangeResult {
	rows: RangeRow[];
	start: number;
	end: number;
	total_rows: number;
	missing_columns: string[];
}

export type AggregateOperation = 'sum' | 'count' | 'counta' | 'avg' | 'min' | 'max';

export interface AggregateRequest {
	sheetId: string;
	operation: AggregateOperation;
	column: string;
	/** 1-based inclusive row numbers. Omit both for the whole column. */
	start?: number;
	end?: number;
	parentId?: string;
}

export interface AggregateResponse {
	value: number | null;
	row_count: number;
}

export function isFormulaCell(value: unknown): value is FormulaCell {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { formula?: unknown }).formula === 'string'
	);
}

export function isCellList(value: unknown): value is CellList {
	return Array.isArray(value);
}

/**
 * Scalar view of a stored cell: cached value for formulas, the primitive
 * itself, or a comma-joined list (so formulas, search and sorting can use
 * multi-value cells).
 */
export function cellPrimitive(value: CellValue | undefined): CellPrimitive {
	if (value === undefined) return null;
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		return value.map((item) => (typeof item === 'string' ? item : item.text)).join(', ');
	}
	if (isFormulaCell(value)) return value.value ?? null;
	return value;
}

/** Empty cells are removed from row documents rather than stored. */
export function isEmptyCellValue(value: CellValue | undefined): boolean {
	return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}
