import type { AvailableColumn } from '@/lib/reports/types';
import type { ReportDraft } from '../types';
import { normalizeText } from '../text';
import { parseFilters, parseGroupColumn, parseMetric } from './query-parse';

/** Turns a description like "unpaid invoices over $500, grouped by supplier" into filters,
 *  grouping and totals against the report's current source sheets. */
export function draftReportQuery(prompt: string, available: AvailableColumn[]): ReportDraft {
	const text = ` ${normalizeText(prompt)} `;
	const usable = available.filter((column) => !column.protected);
	const { filters, notes } = parseFilters(prompt, usable);

	const groupColumn = parseGroupColumn(
		prompt,
		usable,
		filters.map((filter) => filter.column)
	);
	const aging = groupColumn?.kind === 'date' && (/\baging\b/.test(text) || filters.some((filter) => filter.op === 'before' && filter.value === 'today'));
	if (groupColumn) notes.push(`Grouped by ${groupColumn.label}${aging ? ', by days overdue' : ''}.`);

	const metric = parseMetric(prompt, usable);
	const summaries = metric.column ? [{ column: metric.column.name, fn: (metric.fn === 'avg' ? 'avg' : 'sum') as 'avg' | 'sum' }] : [];
	if (metric.column) notes.push(`Totalled the ${metric.fn === 'avg' ? 'average' : 'sum'} of ${metric.column.label}.`);

	const wantsDesc = /\b(largest|biggest|highest|most)\b/.test(text);
	const wantsAsc = /\b(smallest|lowest|least)\b/.test(text);
	const sort = metric.column && (wantsDesc || wantsAsc) ? { column: metric.column.name, direction: (wantsDesc ? 'desc' : 'asc') as 'asc' | 'desc' } : null;
	if (sort) notes.push(`Sorted by ${metric.column!.label}, ${sort.direction === 'desc' ? 'largest' : 'smallest'} first.`);

	if (filters.length === 0 && !groupColumn && !metric.column) {
		notes.push('Nothing specific matched, so this starts with no filters — add what you need above.');
	}

	return { match: 'all', filters, groupBy: groupColumn?.name ?? null, aging: !!aging, summaries, sort, notes };
}
