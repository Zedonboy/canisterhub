import type { CellValue, Column } from '@/lib/types';

/** Pseudo column holding each row's source sheet name (usable anywhere a column name is). */
export const SHEET_NAME_FIELD = '@sheet';

export type ReportColumnKind = 'text' | 'number' | 'date' | 'enum' | 'boolean';

export type ReportFilterOp =
	| 'is'
	| 'is_not'
	| 'contains'
	| 'not_contains'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'before'
	| 'after'
	| 'in_last_days'
	| 'in_next_days'
	| 'is_empty'
	| 'not_empty';

export interface ReportFilter {
	id: string;
	/** Column name, matched case-insensitively in each source sheet. */
	column: string;
	op: ReportFilterOp;
	/** Text as entered; dates are YYYY-MM-DD or "today", day counts for in_last/next_days. */
	value: string;
}

export type SummaryFunction = 'sum' | 'avg' | 'min' | 'max' | 'count';

export interface ReportSummary {
	id: string;
	column: string;
	fn: SummaryFunction;
}

export interface ReportSort {
	column: string;
	direction: 'asc' | 'desc';
}

/**
 * A saved row report: a query over one or more sheets, not a copy of their data.
 * Columns are referenced by name so sheets with the same column names combine.
 */
export interface ReportDefinition {
	id: string;
	name: string;
	description: string;
	/** Sheet ids (local or server) the report reads rows from. */
	sources: string[];
	/** Column names to show, in order. */
	columns: string[];
	match: 'all' | 'any';
	filters: ReportFilter[];
	groupBy: string | null;
	/**
	 * When `groupBy` names a date column, bucket rows by days overdue (today minus the date)
	 * into these ascending day cutoffs instead of grouping by the exact date — the classic AR/AP
	 * aging report. E.g. `[0, 30, 60, 90]` gives Current, 1–30, 31–60, 61–90, 90+ days. `null`
	 * groups by the column's exact displayed value, as with any other column.
	 */
	ageBuckets: number[] | null;
	summaries: ReportSummary[];
	sort: ReportSort | null;
	createdAt: string;
	updatedAt: string;
}

/** A column name offered by the builder, described from the first source sheet that has it. */
export interface AvailableColumn {
	name: string;
	label: string;
	kind: ReportColumnKind;
	/** Representative column used for formatting; null for the sheet name pseudo column. */
	column: Column | null;
	/** How many source sheets have a column with this name. */
	sheetCount: number;
	/** Enum options, for filter value pickers and group order. */
	options: string[];
	/** Protected columns are shown masked and can't be filtered, grouped, sorted or summarised. */
	protected: boolean;
}

export interface ReportRow {
	key: string;
	sheetId: string;
	sheetName: string;
	rowId: string;
	/** Cell values by report column name (Protected values already masked). */
	values: Record<string, CellValue | undefined>;
	/** Formatted text by report column name. */
	display: Record<string, string>;
}

export interface SummaryValue {
	fn: SummaryFunction;
	text: string;
	/** Raw result for charts: a number, or days since 1970 for date min/max; null when there was nothing to summarise. */
	value: number | null;
}

export interface ReportGroup {
	key: string;
	label: string;
	rows: ReportRow[];
	/** Summary results by column name. */
	summaries: Record<string, SummaryValue>;
}

export interface ReportNotice {
	sheetName: string;
	message: string;
}

export interface ReportResult {
	columns: AvailableColumn[];
	rows: ReportRow[];
	groups: ReportGroup[] | null;
	totals: Record<string, SummaryValue>;
	/** Source sheets that were read. */
	sheetCount: number;
	notices: ReportNotice[];
	ranAt: string;
}
