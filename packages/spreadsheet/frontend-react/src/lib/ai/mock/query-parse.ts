/**
 * Free-text parsing shared by "Describe a report" and "Describe a dashboard": turning a sentence
 * like "unpaid invoices over $500, grouped by supplier" into filters, a metric and a group column
 * against a sheet's (or several sheets') `AvailableColumn`s. Deliberately reuses the same shape
 * of pattern as `mock/ask.ts`'s question parsing, just building a saved query instead of an
 * answer.
 */
import type { AvailableColumn, ReportFilterOp } from '@/lib/reports/types';
import { normalizeText, parseLooseNumber } from '../text';

export interface ParsedFilter {
	column: string;
	op: ReportFilterOp;
	value: string;
}

const OPERATORS: Array<[RegExp, ReportFilterOp]> = [
	[/\b(at least|no less than|minimum of)\s*[$₦€£]?\s*([\d,.]+k?)/, 'gte'],
	[/\b(at most|no more than|up to|maximum of)\s*[$₦€£]?\s*([\d,.]+k?)/, 'lte'],
	[/\b(over|above|more than|greater than|exceeding|bigger than|higher than)\s*[$₦€£]?\s*([\d,.]+k?)/, 'gt'],
	[/\b(under|below|less than|fewer than|lower than|smaller than)\s*[$₦€£]?\s*([\d,.]+k?)/, 'lt']
];

const NEGATED_BEFORE = /\b(not|no|except|excluding|other than|isn t|aren t)\s*$/;

/** Enum value mentions (is / is not), a numeric comparison, and date-relative phrases. */
export function parseFilters(prompt: string, columns: AvailableColumn[]): { filters: ParsedFilter[]; notes: string[] } {
	const text = ` ${normalizeText(prompt)} `;
	const usable = columns.filter((column) => !column.protected);
	const filters: ParsedFilter[] = [];
	const notes: string[] = [];

	for (const column of usable.filter((candidate) => candidate.kind === 'enum')) {
		for (const option of column.options) {
			const needle = normalizeText(option);
			if (!needle) continue;
			const index = text.indexOf(` ${needle} `);
			if (index < 0) continue;
			const negated = NEGATED_BEFORE.test(text.slice(Math.max(0, index - 24), index));
			filters.push({ column: column.name, op: negated ? 'is_not' : 'is', value: option });
			notes.push(`${column.label} ${negated ? 'is not' : 'is'} "${option}".`);
			break; // one value per enum column
		}
	}

	const numeric = usable.filter((column) => column.kind === 'number');
	// Matched against the lightly-cased prompt, not `text` — normalizeText strips the comma out of
	// "$1,000", which would otherwise truncate the captured amount to "1".
	const rawText = ` ${prompt.toLowerCase()} `;
	for (const [pattern, op] of OPERATORS) {
		const match = rawText.match(pattern);
		if (!match || match.index === undefined) continue;
		const amount = parseLooseNumber(match[2]);
		if (amount === null) break;
		// A numeric column named just before the number wins; otherwise the sheet's first one.
		const before = normalizeText(rawText.slice(Math.max(0, match.index - 40), match.index));
		const target = numeric.find((column) => before.includes(normalizeText(column.name))) ?? numeric[0];
		if (target) {
			const symbol = ({ gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most' } as Partial<Record<ReportFilterOp, string>>)[op];
			filters.push({ column: target.name, op, value: String(amount) });
			notes.push(`${target.label} is ${symbol} ${amount.toLocaleString()}.`);
		}
		break;
	}

	const dateColumns = usable.filter((column) => column.kind === 'date');
	const dueColumn = dateColumns.find((column) => /due/i.test(column.name)) ?? dateColumns[0];
	if (dueColumn && /\boverdue\b/.test(text)) {
		filters.push({ column: dueColumn.name, op: 'before', value: 'today' });
		notes.push(`${dueColumn.label} is before today (overdue).`);
	}
	const lastDays = text.match(/\bin the last (\d+) days?\b/);
	if (lastDays && dateColumns[0]) {
		filters.push({ column: dateColumns[0].name, op: 'in_last_days', value: lastDays[1] });
		notes.push(`${dateColumns[0].label} is in the last ${lastDays[1]} days.`);
	}
	const nextDays = text.match(/\bin the next (\d+) days?\b|\bdue (?:within|in) (\d+) days?\b/);
	if (nextDays && dueColumn) {
		const days = nextDays[1] ?? nextDays[2];
		filters.push({ column: dueColumn.name, op: 'in_next_days', value: days });
		notes.push(`${dueColumn.label} is in the next ${days} days.`);
	}

	return { filters, notes };
}

/** The column a "total/sum/average X" (or bare "how many") phrase names. */
export function parseMetric(prompt: string, columns: AvailableColumn[]): { column: AvailableColumn | null; fn: 'sum' | 'avg' | 'count' } {
	const text = ` ${normalizeText(prompt)} `;
	const numeric = columns.filter((column) => !column.protected && column.kind === 'number');
	const wantsAvg = /\b(average|avg|mean)\b/.test(text);
	const wantsTotal = /\b(total|sum|combined|altogether)\b/.test(text);
	const wantsCount = /\b(how many|count|number of)\b/.test(text);

	const mentioned = numeric.find((column) => text.includes(` ${normalizeText(column.name)} `));
	if (mentioned) return { column: mentioned, fn: wantsAvg ? 'avg' : 'sum' };
	if (wantsCount && !wantsAvg && !wantsTotal) return { column: null, fn: 'count' };
	if ((wantsAvg || wantsTotal) && numeric[0]) return { column: numeric[0], fn: wantsAvg ? 'avg' : 'sum' };
	return { column: null, fn: 'count' };
}

/** The column a "grouped by X" / "by X" / "per X" phrase names. */
export function parseGroupColumn(prompt: string, columns: AvailableColumn[], exclude: string[] = []): AvailableColumn | null {
	const phrase = prompt.match(/\b(?:grouped?\s+by|per)\s+([a-z][a-z\s]{1,40}?)(?:[,.;]|\s+(?:and|with|showing)\b|$)/i)?.[1];
	if (!phrase) return null;
	const needle = normalizeText(phrase);
	if (!needle) return null;
	return (
		columns.find((column) => !exclude.includes(column.name) && normalizeText(column.name) === needle) ??
		columns.find((column) => !exclude.includes(column.name) && needle.includes(normalizeText(column.name)) && normalizeText(column.name).length > 2) ??
		null
	);
}
