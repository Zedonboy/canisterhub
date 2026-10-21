import { availableColumns } from '@/lib/reports/columns';
import type { AvailableColumn } from '@/lib/reports/types';
import type { Column, Sheet } from '@/lib/types';
import type { DashboardDraft, DashboardKpiDraft } from '../types';
import { titleCase } from '../text';
import { parseFilters, parseMetric } from './query-parse';

/** Splits "unpaid invoices, and overdue ones over $1,000" into separate KPI clauses. */
function splitClauses(prompt: string): string[] {
	const parts = prompt
		.split(/(?:,\s*and\s+|\band also\b|\balso\b|;|\n)/i)
		.map((part) => part.trim())
		.filter(Boolean);
	return (parts.length ? parts : [prompt]).slice(0, 4);
}

function titleFor(clause: string, metric: { column: AvailableColumn | null; fn: 'sum' | 'avg' | 'count' }): string {
	if (metric.fn === 'count' && !metric.column) {
		const subject = clause.match(/(?:count|number)\s+of\s+([a-z][a-z\s]{2,40})/i)?.[1]?.trim();
		return subject ? titleCase(subject) : 'Row count';
	}
	if (!metric.column) return 'Row count';
	return metric.fn === 'avg' ? `Average ${metric.column.name}` : `Total ${metric.column.name}`;
}

/** Turns a description like "unpaid invoices, and overdue ones over $1,000" into KPI tiles for the sheet. */
export function draftDashboard(prompt: string, sheet: Sheet, columns: Column[]): DashboardDraft {
	const available = availableColumns([{ sheet, columns }]);
	const usable = available.filter((column) => !column.protected);
	const dateColumn = usable.find((column) => column.kind === 'date' && /due/i.test(column.name)) ?? usable.find((column) => column.kind === 'date');

	const notes: string[] = [];
	const widgets: DashboardKpiDraft[] = [];
	for (const clause of splitClauses(prompt)) {
		const { filters, notes: filterNotes } = parseFilters(clause, usable);
		const metric = parseMetric(clause, usable);
		const title = titleFor(clause, metric);
		widgets.push({ title, column: metric.column?.name ?? null, fn: metric.fn, match: 'all', filters, trendColumn: dateColumn?.name ?? null });
		notes.push(...filterNotes.map((note) => `${title}: ${note}`));
	}

	if (widgets.length === 0 || widgets.every((widget) => !widget.column && widget.filters.length === 0)) {
		notes.push('Nothing specific matched, so this starts with a row count. Edit the tile to add filters.');
	}

	return { widgets, notes };
}
