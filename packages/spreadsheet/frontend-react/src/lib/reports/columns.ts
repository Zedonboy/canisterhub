import type { Column, Sheet } from '@/lib/types';
import {
	SHEET_NAME_FIELD,
	type AvailableColumn,
	type ReportColumnKind,
	type ReportFilterOp,
	type SummaryFunction
} from './types';

export interface SourceSheet {
	sheet: Sheet;
	columns: Column[];
}

export const normalizeName = (name: string) => name.trim().toLowerCase();

export function columnKind(column: Column): ReportColumnKind {
	switch (column.data_type) {
		case 'number':
		case 'currency':
			return 'number';
		case 'date':
			return 'date';
		case 'enum':
			return 'enum';
		case 'boolean':
			return 'boolean';
		case 'text': {
			// Text columns holding formulas display their results in a chosen format.
			const format = column.settings.format;
			if (format === 'number' || format === 'currency' || format === 'percent') return 'number';
			return format === 'date' ? 'date' : 'text';
		}
		default:
			return 'text';
	}
}

/** Every column name across the sources (first sheet's order first), plus the sheet name. */
export function availableColumns(sources: SourceSheet[]): AvailableColumn[] {
	const byName = new Map<string, AvailableColumn>();
	for (const { columns } of sources) {
		for (const column of [...columns].sort((a, b) => a.position - b.position)) {
			const key = normalizeName(column.name);
			const existing = byName.get(key);
			if (existing) {
				existing.sheetCount++;
				for (const option of column.settings.options ?? []) {
					if (!existing.options.includes(option.value)) existing.options.push(option.value);
				}
				continue;
			}
			byName.set(key, {
				name: column.name,
				label: column.name,
				kind: columnKind(column),
				column,
				sheetCount: 1,
				options: column.data_type === 'enum' ? (column.settings.options ?? []).map((option) => option.value) : [],
				protected: column.data_type === 'protected'
			});
		}
	}
	return [
		{
			name: SHEET_NAME_FIELD,
			label: 'Sheet name',
			kind: 'text',
			column: null,
			sheetCount: sources.length,
			options: sources.map((source) => source.sheet.name),
			protected: false
		},
		...byName.values()
	];
}

export function findAvailable(available: AvailableColumn[], name: string | null | undefined): AvailableColumn | undefined {
	if (!name) return undefined;
	const key = normalizeName(name);
	return available.find((column) => normalizeName(column.name) === key);
}

/** Columns a new report starts with: those every source shares, or the first sheet's leading columns. */
export function defaultReportColumns(sources: SourceSheet[]): string[] {
	if (sources.length === 0) return [];
	const visible = (columns: Column[]) =>
		[...columns].sort((a, b) => a.position - b.position).filter((column) => column.data_type !== 'protected');
	const [first, ...rest] = sources;
	const shared = visible(first.columns)
		.map((column) => column.name)
		.filter((name) => rest.every((source) => source.columns.some((column) => normalizeName(column.name) === normalizeName(name))));
	let names = shared.length >= 2 ? shared : visible(first.columns).map((column) => column.name);
	// Keep the first sheet's primary column so every row has something that identifies it.
	const primary = visible(first.columns).find((column) => column.settings.primary)?.name;
	if (primary && !names.some((name) => normalizeName(name) === normalizeName(primary))) names = [primary, ...names];
	names = names.slice(0, 8);
	return sources.length > 1 ? [SHEET_NAME_FIELD, ...names] : names;
}

export const FILTER_OPERATORS: Record<ReportColumnKind, { value: ReportFilterOp; label: string }[]> = {
	text: [
		{ value: 'is', label: 'is' },
		{ value: 'is_not', label: 'is not' },
		{ value: 'contains', label: 'contains' },
		{ value: 'not_contains', label: 'does not contain' },
		{ value: 'is_empty', label: 'is blank' },
		{ value: 'not_empty', label: 'is not blank' }
	],
	enum: [
		{ value: 'is', label: 'is' },
		{ value: 'is_not', label: 'is not' },
		{ value: 'is_empty', label: 'is blank' },
		{ value: 'not_empty', label: 'is not blank' }
	],
	number: [
		{ value: 'is', label: '=' },
		{ value: 'is_not', label: '≠' },
		{ value: 'gt', label: '>' },
		{ value: 'gte', label: '≥' },
		{ value: 'lt', label: '<' },
		{ value: 'lte', label: '≤' },
		{ value: 'is_empty', label: 'is blank' },
		{ value: 'not_empty', label: 'is not blank' }
	],
	date: [
		{ value: 'is', label: 'is on' },
		{ value: 'before', label: 'is before' },
		{ value: 'after', label: 'is after' },
		{ value: 'in_last_days', label: 'is in the last' },
		{ value: 'in_next_days', label: 'is in the next' },
		{ value: 'is_empty', label: 'is blank' },
		{ value: 'not_empty', label: 'is not blank' }
	],
	boolean: [{ value: 'is', label: 'is' }]
};

export const filterNeedsValue = (op: ReportFilterOp) => op !== 'is_empty' && op !== 'not_empty';

export const SUMMARY_LABELS: Record<SummaryFunction, string> = {
	sum: 'Sum',
	avg: 'Average',
	min: 'Min',
	max: 'Max',
	count: 'Count'
};

export function summaryFunctionsFor(kind: ReportColumnKind): SummaryFunction[] {
	if (kind === 'number') return ['sum', 'avg', 'min', 'max', 'count'];
	if (kind === 'date') return ['min', 'max', 'count'];
	return ['count'];
}

/** Classic AR/AP aging cutoffs, in days overdue: Current, 1–30, 31–60, 61–90, 90+. */
export const DEFAULT_AGE_BUCKETS = [0, 30, 60, 90];

// `newId` was extracted to lib/utils/id.ts in Phase 2a (it's a general-purpose id generator,
// not reports-specific) — re-exported here since every existing caller of this file imports
// it from here.
export { newId } from '@/lib/utils/id';
