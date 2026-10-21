import type { ChartData, DateBucket } from '@/lib/charts/types';
import type { ReportFilter, ReportNotice, SummaryFunction } from '@/lib/reports/types';

/**
 * A single number, read live from a sheet: an aggregate (sum, average, count…) over filtered
 * rows, optionally compared against the same query run as of some days ago, optionally with a
 * small trend line bucketed from a date column. Self-contained, like `ChartDefinition` — not a
 * reference to a saved report, so a widget survives that report being edited or deleted.
 */
export interface KpiWidget {
	id: string;
	kind: 'kpi';
	title: string;
	sheetId: string;
	/** Value column; `null` counts matching rows. */
	column: string | null;
	fn: SummaryFunction;
	match: 'all' | 'any';
	filters: ReportFilter[];
	/** Compare against the same query run this many days ago; `null` shows no comparison. */
	compareDays: number | null;
	/** Date column bucketed for a small trend line under the number; `null` shows no trend. */
	trendColumn: string | null;
	trendBucket: DateBucket;
}

/** Shows a saved chart. Removed automatically (with a placeholder) if that chart is deleted. */
export interface ChartWidget {
	id: string;
	kind: 'chart';
	chartId: string;
}

/** Shows a saved report's table, capped to its first rows. */
export interface ReportWidget {
	id: string;
	kind: 'report';
	reportId: string;
	maxRows: number;
}

/** A written summary stitching together the dashboard's other KPI tiles — refreshed on demand, not saved. */
export interface InsightWidget {
	id: string;
	kind: 'insight';
}

export type DashboardWidget = KpiWidget | ChartWidget | ReportWidget | InsightWidget;

/** A page combining KPI tiles, charts and report tables — a monthly report pack, read live. */
export interface DashboardDefinition {
	id: string;
	name: string;
	description: string;
	widgets: DashboardWidget[];
	createdAt: string;
	updatedAt: string;
}

export const COMPARE_PRESETS: { days: number; label: string }[] = [
	{ days: 1, label: 'vs yesterday' },
	{ days: 7, label: 'vs a week ago' },
	{ days: 30, label: 'vs a month ago' },
	{ days: 90, label: 'vs a quarter ago' },
	{ days: 365, label: 'vs a year ago' }
];

export interface KpiCompareResult {
	value: number | null;
	text: string;
	/** Fraction, e.g. 0.12 for +12%; `null` when there's nothing to compare against (a zero or blank prior value). */
	changePct: number | null;
	label: string;
}

export interface KpiResult {
	value: number | null;
	text: string;
	compare: KpiCompareResult | null;
	/** For `<ChartView type="line" compact>`; `null` when no trend column is set. */
	trend: ChartData | null;
	rowCount: number;
	notices: ReportNotice[];
	ranAt: string;
}
