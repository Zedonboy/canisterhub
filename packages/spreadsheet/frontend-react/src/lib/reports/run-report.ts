import { cellDisplayText, formatPrimitive, PROTECTED_MASK } from '@/lib/grid/cell-text';
import { sheetRepository } from '@/lib/storage';
import { cellPrimitive, isEmptyCellValue, type CellPrimitive, type CellValue, type Column, type RowFilterClause } from '@/lib/types';
import { formatCount, formatDate } from '@/lib/utils/format';
import { availableColumns, columnKind, filterNeedsValue, findAvailable, normalizeName, type SourceSheet } from './columns';
import {
	SHEET_NAME_FIELD,
	type AvailableColumn,
	type ReportColumnKind,
	type ReportDefinition,
	type ReportFilter,
	type ReportGroup,
	type ReportNotice,
	type ReportResult,
	type ReportRow,
	type ReportSummary,
	type SummaryValue
} from './types';

const PAGE = 500;
/** Matching rows kept per source sheet. */
export const MAX_ROWS_PER_SHEET = 5_000;
/** Rows read per source sheet when filters can't be applied by the storage layer. */
export const MAX_SCANNED_PER_SHEET = 50_000;

type Repository = Pick<typeof sheetRepository, 'getSheet' | 'listColumns' | 'getRowPage'>;

export async function loadSources(
	ids: string[],
	repository: Repository = sheetRepository
): Promise<{ sources: SourceSheet[]; notices: ReportNotice[] }> {
	const settled = await Promise.allSettled(
		ids.map(async (id) => {
			const [sheet, columns] = await Promise.all([repository.getSheet(id), repository.listColumns(id)]);
			return { sheet, columns };
		})
	);
	const sources: SourceSheet[] = [];
	const notices: ReportNotice[] = [];
	for (const outcome of settled) {
		if (outcome.status === 'fulfilled') sources.push(outcome.value);
		else {
			const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			notices.push({
				sheetName: 'A source sheet',
				message: `couldn't be read (${reason}). It may have been deleted, or the server may be unreachable.`
			});
		}
	}
	return { sources, notices };
}

/**
 * Runs a report: reads matching rows from each source, then sorts, groups and summarises them.
 *
 * `asOf` overrides what "today" means to the filters and aging buckets — every relative filter
 * (`in_last_days`, "is today", "before"/"after" today…) is evaluated as if run on that date
 * instead of the real one. Dashboards use this to compare a KPI against N days ago by re-running
 * its own filters with `asOf` shifted back, rather than needing a second, hand-built filter set.
 */
export async function runReport(
	definition: ReportDefinition,
	repository: Repository = sheetRepository,
	asOf?: string
): Promise<ReportResult> {
	const { sources, notices } = await loadSources(definition.sources, repository);
	const available = availableColumns(sources);
	const today = asOf ?? todayIso();
	const filters = definition.filters.filter((filter) => !filterNeedsValue(filter.op) || filter.value.trim() !== '');
	const fields = unique([
		...definition.columns,
		definition.groupBy,
		definition.sort?.column,
		...definition.summaries.map((summary) => summary.column)
	]);

	const rows: ReportRow[] = [];
	for (const source of sources) {
		rows.push(...(await collectRows(definition, filters, fields, source, today, notices, repository)));
	}

	const sortColumn = findAvailable(available, definition.sort?.column);
	if (definition.sort && sortColumn && !sortColumn.protected) {
		const { column, direction } = definition.sort;
		rows.sort((a, b) => compareForSort(a.values[column], b.values[column], sortColumn.kind, direction));
	}

	const groupColumn = findAvailable(available, definition.groupBy);
	const summaries = definition.summaries.filter((summary) => {
		const column = findAvailable(available, summary.column);
		return column && !column.protected;
	});
	const groups =
		definition.groupBy && groupColumn && !groupColumn.protected
			? groupRows(rows, definition.groupBy, groupColumn, definition.sort, summaries, available, definition.ageBuckets, today)
			: null;

	return {
		columns: available,
		rows,
		groups,
		totals: summarize(rows, summaries, available),
		sheetCount: sources.length,
		notices,
		ranAt: new Date().toISOString()
	};
}

async function collectRows(
	definition: ReportDefinition,
	filters: ReportFilter[],
	fields: string[],
	source: SourceSheet,
	today: string,
	notices: ReportNotice[],
	repository: Repository
): Promise<ReportRow[]> {
	const { sheet } = source;
	const byName = new Map(source.columns.map((column) => [normalizeName(column.name), column]));
	const find = (name: string) => byName.get(normalizeName(name));
	const valueOf = (data: Record<string, CellValue>, name: string): CellValue | undefined =>
		name === SHEET_NAME_FIELD ? sheet.name : (() => {
			const column = find(name);
			return column ? data[column.key] : undefined;
		})();
	const matches = (data: Record<string, CellValue>) => {
		if (filters.length === 0) return true;
		const test = (filter: ReportFilter) => filterMatches(filter, valueOf(data, filter.column), find(filter.column), today);
		return definition.match === 'all' ? filters.every(test) : filters.some(test);
	};

	// With "all", a filter that fails for every row of this sheet (e.g. a column it lacks, or
	// a sheet-name filter) means no row can match, so skip reading the sheet.
	if (definition.match === 'all') {
		const impossible = filters.some((filter) => {
			if (filter.column === SHEET_NAME_FIELD) return !filterMatches(filter, sheet.name, undefined, today);
			return !find(filter.column) && !filterMatches(filter, undefined, undefined, today);
		});
		if (impossible) return [];
	}

	// Filters the storage layer applies the same way narrow the rows it returns; every
	// filter is still checked here, so these only make large sheets faster.
	const pushdown = definition.match === 'all' ? filters.flatMap((filter) => pushdownClause(filter, find(filter.column))) : [];
	const keys = unique(fields.map((name) => find(name)?.key));
	for (const filter of filters) {
		const key = find(filter.column)?.key;
		if (key && !keys.includes(key)) keys.push(key);
	}

	const rows: ReportRow[] = [];
	let offset = 0;
	let scanned = 0;
	let limited: 'rows' | 'scan' | null = null;
	for (;;) {
		const page = await repository.getRowPage(sheet.id, {
			offset,
			limit: PAGE,
			filter: pushdown.length ? pushdown : undefined,
			columns: keys.length ? keys : undefined
		});
		for (const row of page.rows) {
			scanned++;
			if (!matches(row.data)) continue;
			const values: ReportRow['values'] = {};
			const display: ReportRow['display'] = {};
			for (const name of fields) {
				if (name === SHEET_NAME_FIELD) {
					values[name] = sheet.name;
					display[name] = sheet.name;
					continue;
				}
				const column = find(name);
				const value = column ? row.data[column.key] : undefined;
				values[name] = column?.data_type === 'protected' && !isEmptyCellValue(value) ? PROTECTED_MASK : value;
				display[name] = column ? cellDisplayText(column, value) : '';
			}
			rows.push({ key: `${sheet.id}:${row.id}`, sheetId: sheet.id, sheetName: sheet.name, rowId: row.id, values, display });
			if (rows.length >= MAX_ROWS_PER_SHEET) {
				limited = 'rows';
				break;
			}
		}
		offset += page.rows.length;
		if (limited || page.rows.length < PAGE) break;
		if (scanned >= MAX_SCANNED_PER_SHEET) {
			limited = 'scan';
			break;
		}
	}

	if (limited === 'rows') {
		notices.push({ sheetName: sheet.name, message: `has more matching rows; the report shows the first ${formatCount(MAX_ROWS_PER_SHEET)}.` });
	} else if (limited === 'scan') {
		notices.push({
			sheetName: sheet.name,
			message: `is large, so only its first ${formatCount(MAX_SCANNED_PER_SHEET)} rows were checked. Filters using “contains”, “is blank” or number comparisons with “all” matching search the whole sheet.`
		});
	}
	return rows;
}

function pushdownClause(filter: ReportFilter, column: Column | undefined): RowFilterClause[] {
	if (!column || column.data_type === 'protected') return [];
	switch (filter.op) {
		case 'is_empty':
		case 'not_empty':
			return [{ column: column.key, op: filter.op }];
		case 'contains':
			return [{ column: column.key, op: 'contains', value: filter.value.trim() }];
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte': {
			const number = Number(filter.value);
			const numeric = column.data_type === 'number' || column.data_type === 'currency';
			return numeric && filter.value.trim() !== '' && Number.isFinite(number)
				? [{ column: column.key, op: filter.op, value: number }]
				: [];
		}
		default:
			return [];
	}
}

export function filterMatches(filter: ReportFilter, value: CellValue | undefined, column: Column | undefined, today: string): boolean {
	if (column?.data_type === 'protected') return false;
	const primitive = cellPrimitive(value);
	const empty = primitive === null || primitive === '';
	const text = empty ? '' : String(primitive).trim().toLowerCase();
	const needle = filter.value.trim();
	const kind: ReportColumnKind = column ? columnKind(column) : 'text';

	switch (filter.op) {
		case 'is_empty':
			return empty;
		case 'not_empty':
			return !empty;
		case 'contains':
			return !empty && text.includes(needle.toLowerCase());
		case 'not_contains':
			return empty || !text.includes(needle.toLowerCase());
		case 'is':
			return !empty && equals(kind, primitive, needle, today);
		case 'is_not':
			return empty || !equals(kind, primitive, needle, today);
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte': {
			const a = toNumber(primitive);
			const b = toNumber(needle);
			if (a === null || b === null) return false;
			return filter.op === 'gt' ? a > b : filter.op === 'gte' ? a >= b : filter.op === 'lt' ? a < b : a <= b;
		}
		case 'before':
		case 'after': {
			const day = toIsoDate(primitive);
			const reference = resolveDate(needle, today);
			if (!day || !reference) return false;
			return filter.op === 'before' ? day < reference : day > reference;
		}
		case 'in_last_days':
		case 'in_next_days': {
			const day = toIsoDate(primitive);
			const days = Number(needle);
			if (!day || !Number.isFinite(days)) return false;
			return filter.op === 'in_last_days'
				? day >= addDays(today, -days) && day <= today
				: day >= today && day <= addDays(today, days);
		}
	}
}

function equals(kind: ReportColumnKind, value: CellPrimitive, needle: string, today: string): boolean {
	switch (kind) {
		case 'number': {
			const a = toNumber(value);
			const b = toNumber(needle);
			return a !== null && b !== null && a === b;
		}
		case 'date':
			return toIsoDate(value) === resolveDate(needle, today);
		case 'boolean':
			return String(value === true || String(value).toLowerCase() === 'true') === needle.toLowerCase();
		default:
			return String(value).trim().toLowerCase() === needle.toLowerCase();
	}
}

export function toNumber(value: CellPrimitive | string): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const cleaned = value.replace(/[,$\s]/g, '');
	if (cleaned === '') return null;
	const number = Number(cleaned);
	return Number.isFinite(number) ? number : null;
}

export function toIsoDate(value: CellPrimitive): string | null {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function resolveDate(needle: string, today: string): string | null {
	if (needle.toLowerCase() === 'today') return today;
	return /^\d{4}-\d{2}-\d{2}$/.test(needle) ? needle : null;
}

export function todayIso(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(iso: string, days: number): string {
	const [year, month, day] = iso.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Empty values sort last in both directions. */
export function compareForSort(a: CellValue | undefined, b: CellValue | undefined, kind: ReportColumnKind, direction: 'asc' | 'desc'): number {
	const pa = cellPrimitive(a);
	const pb = cellPrimitive(b);
	const emptyA = pa === null || pa === '';
	const emptyB = pb === null || pb === '';
	if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
	const sign = direction === 'desc' ? -1 : 1;
	if (kind === 'number') {
		const na = toNumber(pa);
		const nb = toNumber(pb);
		if (na !== null && nb !== null) return (na - nb) * sign;
	}
	return String(pa).localeCompare(String(pb), undefined, { numeric: true, sensitivity: 'base' }) * sign;
}

/** Bucket label for a number of days overdue, against ascending day cutoffs (see `ReportDefinition.ageBuckets`). */
export function agingBucketLabel(daysOverdue: number, cutoffs: number[]): { key: string; label: string } {
	const sorted = [...cutoffs].sort((a, b) => a - b);
	if (daysOverdue <= sorted[0]) return { key: '0', label: sorted[0] <= 0 ? 'Current' : `Up to ${sorted[0]} days` };
	for (let i = 1; i < sorted.length; i++) {
		if (daysOverdue <= sorted[i]) return { key: String(i), label: `${sorted[i - 1] + 1}–${sorted[i]} days` };
	}
	// The conventional AR/AP aging label names the cutoff itself ("90+"), not the day after it.
	return { key: String(sorted.length), label: `${sorted[sorted.length - 1]}+ days` };
}

const AGE_BLANK_KEY = '\0blank';

function groupRows(
	rows: ReportRow[],
	field: string,
	column: AvailableColumn,
	sort: ReportDefinition['sort'],
	summaries: ReportSummary[],
	available: AvailableColumn[],
	ageBuckets: number[] | null,
	today: string
): ReportGroup[] {
	const aging = !!ageBuckets?.length && column.kind === 'date';
	const groups = new Map<string, ReportGroup>();
	for (const row of rows) {
		let key: string;
		let label: string;
		if (aging) {
			const day = toIsoDate(cellPrimitive(row.values[field]));
			if (day) {
				const daysOverdue = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
				({ key, label } = agingBucketLabel(daysOverdue, ageBuckets!));
			} else {
				key = AGE_BLANK_KEY;
				label = '(blank)';
			}
		} else {
			label = row.display[field] ?? '';
			key = label;
		}
		let group = groups.get(key);
		if (!group) {
			group = { key, label: label || '(blank)', rows: [], summaries: {} };
			groups.set(key, group);
		}
		group.rows.push(row);
	}

	const list = [...groups.values()];
	if (aging) {
		// Bucket order (Current, 1–30, 31–60…), blanks last — not the values' own order.
		list.sort((a, b) => (a.key === b.key ? 0 : a.key === AGE_BLANK_KEY ? 1 : b.key === AGE_BLANK_KEY ? -1 : Number(a.key) - Number(b.key)));
	} else if (normalizeName(sort?.column ?? '') !== normalizeName(field)) {
		// Sorting by the grouped column already ordered the groups; otherwise use option order or the values.
		list.sort((a, b) => {
			if (!a.key || !b.key) return a.key === b.key ? 0 : a.key ? -1 : 1;
			if (column.kind === 'enum') {
				const ia = column.options.indexOf(a.key);
				const ib = column.options.indexOf(b.key);
				if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
			}
			return compareForSort(a.rows[0].values[field], b.rows[0].values[field], column.kind, 'asc');
		});
	}
	for (const group of list) group.summaries = summarize(group.rows, summaries, available);
	return list;
}

function summarize(rows: ReportRow[], summaries: ReportSummary[], available: AvailableColumn[]): Record<string, SummaryValue> {
	const result: Record<string, SummaryValue> = {};
	for (const summary of summaries) {
		const column = findAvailable(available, summary.column);
		if (!column) continue;
		const primitives = rows
			.map((row) => cellPrimitive(row.values[summary.column]))
			.filter((value): value is string | number | boolean => value !== null && value !== '');

		if (summary.fn === 'count') {
			result[summary.column] = { fn: 'count', text: formatCount(primitives.length), value: primitives.length };
			continue;
		}
		if (column.kind === 'date') {
			const days = primitives.map(toIsoDate).filter((day): day is string => !!day).sort();
			const day = summary.fn === 'min' ? days[0] : days[days.length - 1];
			result[summary.column] = { fn: summary.fn, text: day ? formatDate(day) : '', value: day ? Date.parse(day) / 86_400_000 : null };
			continue;
		}
		const numbers = primitives.map(toNumber).filter((number): number is number => number !== null);
		if (numbers.length === 0) {
			result[summary.column] = { fn: summary.fn, text: '', value: null };
			continue;
		}
		const total = numbers.reduce((sum, number) => sum + number, 0);
		const value =
			summary.fn === 'sum'
				? total
				: summary.fn === 'avg'
					? total / numbers.length
					: summary.fn === 'min'
						? Math.min(...numbers)
						: Math.max(...numbers);
		result[summary.column] = { fn: summary.fn, text: column.column ? formatPrimitive(column.column, value) : String(value), value };
	}
	return result;
}

function unique(values: (string | null | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => !!value))];
}
