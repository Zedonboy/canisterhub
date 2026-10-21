import { buildChart } from '@/lib/charts/build-chart';
import type { ChartDefinition } from '@/lib/charts/types';
import { newId } from '@/lib/reports/columns';
import { addDays, runReport, todayIso } from '@/lib/reports/run-report';
import type { ReportDefinition } from '@/lib/reports/types';
import { sheetRepository } from '@/lib/storage';
import { formatCount } from '@/lib/utils/format';
import type { KpiResult, KpiWidget } from './types';

type Repository = Parameters<typeof runReport>[1];

function definitionFor(widget: KpiWidget, filters = widget.filters): ReportDefinition {
	return {
		id: widget.id,
		name: widget.title,
		description: '',
		sources: [widget.sheetId],
		columns: [],
		match: widget.match,
		filters,
		groupBy: null,
		ageBuckets: null,
		summaries: widget.column ? [{ id: 'kpi', column: widget.column, fn: widget.fn }] : [],
		sort: null,
		createdAt: '',
		updatedAt: ''
	};
}

/**
 * The value column's `count` averages "non-blank cells", which is right for "how many rows have
 * a Supplier" but not for "how many rows" — a KPI with no value column wants the latter, so it
 * reads the row count directly rather than going through a summary column at all.
 */
async function readValue(widget: KpiWidget, filters: KpiWidget['filters'], repository: Repository, asOf?: string) {
	const result = await runReport(definitionFor(widget, filters), repository, asOf);
	if (!widget.column) return { value: result.rows.length, text: formatCount(result.rows.length), result };
	const summary = result.totals[widget.column];
	return { value: summary?.value ?? null, text: summary?.text ?? '—', result };
}

/** Runs a KPI widget's query (and, if configured, its comparison and trend) against live sheet data. */
export async function runKpi(widget: KpiWidget, repository: Repository = sheetRepository): Promise<KpiResult> {
	const current = await readValue(widget, widget.filters, repository);

	let compare: KpiResult['compare'] = null;
	if (widget.compareDays) {
		const preset = COMPARE_LABELS[widget.compareDays] ?? `vs ${widget.compareDays} days ago`;
		const asOf = addDays(todayIso(), -widget.compareDays);
		const previous = await readValue(widget, widget.filters, repository, asOf);
		const changePct =
			current.value !== null && previous.value !== null && previous.value !== 0
				? (current.value - previous.value) / Math.abs(previous.value)
				: null;
		compare = { value: previous.value, text: previous.text, changePct, label: preset };
	}

	let trend: KpiResult['trend'] = null;
	if (widget.trendColumn) {
		const definition: ChartDefinition = {
			id: widget.id,
			name: widget.title,
			description: '',
			sheetId: widget.sheetId,
			type: 'line',
			category: widget.trendColumn,
			dateBucket: widget.trendBucket,
			series: [{ id: newId('series'), column: widget.column, fn: widget.column ? widget.fn : 'count' }],
			match: widget.match,
			filters: widget.filters,
			sort: 'category',
			limit: null,
			stacked: false,
			showValues: false,
			createdAt: '',
			updatedAt: ''
		};
		trend = await buildChart(definition);
	}

	return {
		value: current.value,
		text: current.text,
		compare,
		trend,
		rowCount: current.result.rows.length,
		notices: current.result.notices,
		ranAt: current.result.ranAt
	};
}

const COMPARE_LABELS: Record<number, string> = {
	1: 'vs yesterday',
	7: 'vs a week ago',
	30: 'vs a month ago',
	90: 'vs a quarter ago',
	365: 'vs a year ago'
};
