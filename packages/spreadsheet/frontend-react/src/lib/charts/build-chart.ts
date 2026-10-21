import { formatPrimitive } from '@/lib/grid/cell-text';
import { columnKind, findAvailable, newId, normalizeName } from '@/lib/reports/columns';
import { compareForSort, runReport, toIsoDate, toNumber } from '@/lib/reports/run-report';
import type { AvailableColumn, ReportRow } from '@/lib/reports/types';
import { cellPrimitive, type Column } from '@/lib/types';
import { formatCount, formatDate } from '@/lib/utils/format';
import type { ChartAggregate, ChartCategory, ChartData, ChartDefinition, ChartSeries, ChartType, DateBucket } from './types';

/** Mid-tone series colours that read on both light and dark grounds. Passed straight to LayerChart as `cRange`/`series[].color`. */
export const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444', '#ec4899', '#22c55e', '#64748b'];

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
	bar: 'Column',
	'horizontal-bar': 'Bar',
	line: 'Line',
	area: 'Area',
	pie: 'Pie'
};

export const AGGREGATE_LABELS: Record<ChartAggregate, string> = {
	count: 'Count',
	sum: 'Sum',
	avg: 'Average',
	min: 'Min',
	max: 'Max'
};

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
	day: 'Day',
	week: 'Week',
	month: 'Month',
	quarter: 'Quarter',
	year: 'Year'
};

const BLANK_KEY = '\0blank';

export function seriesLabel(series: ChartSeries, columns: AvailableColumn[]): string {
	if (!series.column) return 'Number of rows';
	const label = findAvailable(columns, series.column)?.label ?? series.column;
	return `${AGGREGATE_LABELS[series.fn]} of ${label}`;
}

/** Reads the sheet's matching rows (through the report engine) and summarises them per category. */
export async function buildChart(definition: ChartDefinition): Promise<ChartData> {
	const seriesColumns = definition.series.flatMap((series) => (series.column ? [series.column] : []));
	const report = await runReport({
		id: definition.id,
		name: definition.name,
		description: '',
		sources: [definition.sheetId],
		columns: [...(definition.category ? [definition.category] : []), ...seriesColumns],
		match: definition.match,
		filters: definition.filters,
		groupBy: null,
		ageBuckets: null,
		summaries: [],
		sort: null,
		createdAt: definition.createdAt,
		updatedAt: definition.updatedAt
	});
	const columns = report.columns;
	const categoryColumn = findAvailable(columns, definition.category);

	const buckets = new Map<string, { key: string; label: string; rows: ReportRow[]; sample: ReportRow }>();
	for (const row of report.rows) {
		const { key, label } = categoryOf(row, definition, categoryColumn);
		const bucket = buckets.get(key);
		if (bucket) bucket.rows.push(row);
		else buckets.set(key, { key, label, rows: [row], sample: row });
	}

	const series = definition.series.map((entry) => ({ entry, column: entry.column ? findAvailable(columns, entry.column) : undefined }));
	let categories: (ChartCategory & { sample: ReportRow })[] = [...buckets.values()].map((bucket) => ({
		key: bucket.key,
		label: bucket.label,
		rows: bucket.rows.length,
		sample: bucket.sample,
		values: series.map(({ entry }) => aggregate(bucket.rows, entry))
	}));

	categories.sort((a, b) => {
		if (a.key === BLANK_KEY || b.key === BLANK_KEY) return a.key === b.key ? 0 : a.key === BLANK_KEY ? 1 : -1;
		if (definition.sort !== 'category') {
			const va = a.values[0];
			const vb = b.values[0];
			if (va !== vb) {
				if (va === null) return 1;
				if (vb === null) return -1;
				return definition.sort === 'value-desc' ? vb - va : va - vb;
			}
		}
		return compareCategories(a, b, definition, categoryColumn);
	});

	let hiddenCategories = 0;
	if (definition.limit && categories.length > definition.limit) {
		hiddenCategories = categories.length - definition.limit;
		categories = categories.slice(0, definition.limit);
	}

	return {
		categories: categories.map(({ sample: _sample, ...category }) => category),
		series: series.map(({ entry, column }) => ({
			id: entry.id,
			label: seriesLabel(entry, columns),
			format: valueFormatter(entry, column?.column ?? null)
		})),
		rowCount: report.rows.length,
		hiddenCategories,
		notices: report.notices,
		columns,
		ranAt: report.ranAt
	};
}

function categoryOf(row: ReportRow, definition: ChartDefinition, column: AvailableColumn | undefined): { key: string; label: string } {
	const name = definition.category;
	if (!name) return { key: 'all', label: 'All rows' };
	if (column?.kind === 'date') {
		const day = toIsoDate(cellPrimitive(row.values[name]));
		return day ? dateBucket(day, definition.dateBucket) : { key: BLANK_KEY, label: '(blank)' };
	}
	const text = row.display[name] ?? '';
	return text ? { key: text, label: text } : { key: BLANK_KEY, label: '(blank)' };
}

const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Groups an ISO date; keys sort chronologically as text. */
export function dateBucket(day: string, bucket: DateBucket): { key: string; label: string } {
	const [year, month, date] = day.split('-').map(Number);
	switch (bucket) {
		case 'day':
			return { key: day, label: formatDate(day) };
		case 'week': {
			const utc = new Date(Date.UTC(year, month - 1, date));
			utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
			return { key: utc.toISOString().slice(0, 10), label: `Week of ${shortDayFormatter.format(utc)}` };
		}
		case 'month':
			return { key: day.slice(0, 7), label: monthFormatter.format(new Date(Date.UTC(year, month - 1, 1))) };
		case 'quarter': {
			const quarter = Math.floor((month - 1) / 3) + 1;
			return { key: `${year}-Q${quarter}`, label: `Q${quarter} ${year}` };
		}
		case 'year':
			return { key: String(year), label: String(year) };
	}
}

function compareCategories(
	a: ChartCategory & { sample: ReportRow },
	b: ChartCategory & { sample: ReportRow },
	definition: ChartDefinition,
	column: AvailableColumn | undefined
): number {
	if (!column || column.kind === 'date') return a.key.localeCompare(b.key);
	if (column.kind === 'enum') {
		const ia = column.options.indexOf(a.key);
		const ib = column.options.indexOf(b.key);
		if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
	}
	const name = definition.category!;
	return compareForSort(a.sample.values[name], b.sample.values[name], column.kind, 'asc');
}

function aggregate(rows: ReportRow[], series: ChartSeries): number | null {
	if (!series.column) return rows.length;
	const column = series.column;
	const primitives = rows.map((row) => cellPrimitive(row.values[column])).filter((value) => value !== null && value !== '');
	if (series.fn === 'count') return primitives.length;
	const numbers = primitives.map(toNumber).filter((number): number is number => number !== null);
	if (numbers.length === 0) return null;
	const total = numbers.reduce((sum, number) => sum + number, 0);
	switch (series.fn) {
		case 'sum':
			return total;
		case 'avg':
			return total / numbers.length;
		case 'min':
			return Math.min(...numbers);
		case 'max':
			return Math.max(...numbers);
	}
}

function valueFormatter(series: ChartSeries, column: Column | null): (value: number) => string {
	if (!series.column || series.fn === 'count' || !column) return (value) => formatCount(value);
	return (value) => formatPrimitive(column, series.fn === 'avg' ? Math.round(value * 100) / 100 : value);
}

/** A sensible first chart for a sheet: a summary of its first number column by an option, date or name column. */
export function suggestChart(columns: Column[]): Pick<ChartDefinition, 'type' | 'category' | 'dateBucket' | 'series' | 'sort' | 'limit' | 'name'> {
	const visible = [...columns].sort((a, b) => a.position - b.position).filter((column) => column.data_type !== 'protected');
	const category =
		visible.find((column) => column.data_type === 'enum') ??
		visible.find((column) => column.data_type === 'date') ??
		visible.find((column) => column.settings.primary) ??
		visible.find((column) => column.data_type === 'text');
	const numeric = visible.find((column) => columnKind(column) === 'number' && column.key !== category?.key);
	const isDate = category?.data_type === 'date';
	const series: ChartSeries = { id: newId('series'), column: numeric?.name ?? null, fn: numeric ? 'sum' : 'count' };
	const valueLabel = numeric ? `${numeric.name}` : 'Rows';
	return {
		type: isDate ? 'line' : 'bar',
		category: category?.name ?? null,
		dateBucket: 'month',
		series: [series],
		sort: isDate ? 'category' : 'value-desc',
		limit: isDate ? null : 12,
		name: category ? `${valueLabel} by ${category.name}` : valueLabel
	};
}

/** Columns a series can summarise with the given function. */
export function seriesColumns(columns: AvailableColumn[], fn: ChartAggregate): AvailableColumn[] {
	return columns.filter(
		(column) => !column.protected && (fn === 'count' ? normalizeName(column.name) !== '@sheet' : column.kind === 'number')
	);
}
