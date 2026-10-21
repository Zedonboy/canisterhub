import type { AvailableColumn, ReportFilter, ReportNotice } from '@/lib/reports/types';

export type ChartType = 'bar' | 'horizontal-bar' | 'line' | 'area' | 'pie';
export type ChartAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type DateBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ChartSort = 'category' | 'value-desc' | 'value-asc';

export interface ChartSeries {
	id: string;
	/** Column name; null counts rows. */
	column: string | null;
	fn: ChartAggregate;
}

/** A saved chart: how to summarise one sheet's rows, re-read each time it's shown. */
export interface ChartDefinition {
	id: string;
	name: string;
	description: string;
	sheetId: string;
	type: ChartType;
	/** Column whose values become the categories (X axis or pie slices); null puts every row in one. */
	category: string | null;
	/** How date categories are grouped. */
	dateBucket: DateBucket;
	series: ChartSeries[];
	match: 'all' | 'any';
	filters: ReportFilter[];
	sort: ChartSort;
	/** Show only the first N categories after sorting. */
	limit: number | null;
	stacked: boolean;
	showValues: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ChartCategory {
	key: string;
	label: string;
	/** One value per series (null when the category had nothing to summarise). */
	values: (number | null)[];
	rows: number;
}

export interface ChartSeriesInfo {
	id: string;
	label: string;
	format: (value: number) => string;
}

export interface ChartData {
	categories: ChartCategory[];
	series: ChartSeriesInfo[];
	/** Rows that passed the filters. */
	rowCount: number;
	/** Categories left out by the limit. */
	hiddenCategories: number;
	notices: ReportNotice[];
	columns: AvailableColumn[];
	ranAt: string;
}
