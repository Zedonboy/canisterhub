import type { RowFilterClause } from '@/lib/types';
import type { AskAnswer, AskStep, ContextRow, SheetContext, SheetTools } from '../types';
import { normalizeText, parseLooseNumber, plural } from '../text';
import { cellNumber, cellText, columnsInText, formatValue, isNumericColumn, primaryColumn, rowLink } from './shared';

const PAGE = 500;
const MAX_SCAN = 2_000;

const OPERATORS: Array<[RegExp, RowFilterClause['op']]> = [
	[/\b(at least|no less than|minimum of)\s*[$₦€£]?\s*([\d,.]+k?)/, 'gte'],
	[/\b(at most|no more than|up to|maximum of)\s*[$₦€£]?\s*([\d,.]+k?)/, 'lte'],
	[/\b(over|above|more than|greater than|exceeding|bigger than|higher than|>)\s*[$₦€£]?\s*([\d,.]+k?)/, 'gt'],
	[/\b(under|below|less than|fewer than|lower than|smaller than|<)\s*[$₦€£]?\s*([\d,.]+k?)/, 'lt']
];

function describeFilter(filter: RowFilterClause, names: Map<string, string>): string {
	const symbol = { eq: '=', neq: '≠', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', is_empty: 'is empty', not_empty: 'is not empty' }[filter.op];
	const value = typeof filter.value === 'string' ? `"${filter.value}"` : String(filter.value ?? '');
	return `${names.get(filter.column) ?? filter.column} ${symbol} ${value}`.trim();
}

/** Example questions built from this sheet's own columns and values. */
export function suggestedQuestions(context: SheetContext): string[] {
	const { columns, rows } = context;
	const suggestions: string[] = [];
	const enumColumn = columns.find((column) => column.data_type === 'enum' && (column.settings.options?.length ?? 0) > 0);
	const money = columns.find((column) => column.data_type === 'currency') ?? columns.find(isNumericColumn);
	const option = enumColumn?.settings.options?.[0]?.value;
	if (enumColumn && option) suggestions.push(`How many rows have ${enumColumn.name} ${option}?`);
	if (money) suggestions.push(`What is the total ${money.name}?`);
	if (money && enumColumn && option) suggestions.push(`Which ${option} rows have the highest ${money.name}?`);
	const parent = rows.find((row) => row.has_children);
	if (parent) {
		const noun = cellText(parent.data[primaryColumn(columns).key]).split(/\s|·/)[0]?.toLowerCase();
		const countColumn = columns.find((column) => rows.some((row) => row.has_children && /^\d+\s+\w/.test(cellText(row.data[column.key]))));
		if (noun && countColumn) suggestions.push(`Which ${noun}s have the most ${countColumn.name.toLowerCase()}?`);
	}
	return suggestions.slice(0, 4);
}

export async function askSheet(question: string, context: SheetContext, tools: SheetTools): Promise<AskAnswer> {
	const { columns } = context;
	const text = ` ${normalizeText(question)} `;
	const steps: AskStep[] = [];
	const names = new Map(columns.map((column) => [column.key, column.name]));

	const protectedColumn = columns.find((column) => column.data_type === 'protected' && text.includes(` ${normalizeText(column.name)} `));
	if (protectedColumn) {
		return {
			answer: `“${protectedColumn.name}” is a Protected column, so its values are never sent to AI. Ask about another column.`,
			steps: [],
			rows: [],
			caveat: null
		};
	}

	const visible = columns.filter((column) => column.data_type !== 'protected');
	const mentioned = columnsInText(question, visible);

	// Filters from values named in the question.
	const filters: RowFilterClause[] = [];
	for (const column of visible.filter((candidate) => candidate.data_type === 'enum')) {
		const option = (column.settings.options ?? []).find((candidate) => text.includes(` ${normalizeText(candidate.value)} `));
		if (option) filters.push({ column: column.key, op: 'eq', value: option.value });
	}
	const quoted = question.match(/["“']([^"”']+)["”']/)?.[1];
	if (quoted) filters.push({ column: primaryColumn(visible).key, op: 'contains', value: quoted });

	const numericMentioned = mentioned.filter(isNumericColumn);
	for (const [pattern, op] of OPERATORS) {
		const match = text.match(pattern);
		if (!match) continue;
		const target = numericMentioned[0] ?? visible.find((column) => column.data_type === 'currency') ?? visible.find(isNumericColumn);
		const amount = parseLooseNumber(match[2]);
		if (target && amount !== null) filters.push({ column: target.key, op, value: amount });
		break;
	}

	const wantsCount = /\b(how many|count|number of)\b/.test(text);
	const wantsSum = /\b(total|sum|combined|altogether)\b/.test(text);
	const wantsAvg = /\b(average|avg|mean|typical)\b/.test(text);
	const wantsMost = /\b(most|highest|largest|biggest|top|max|maximum)\b/.test(text);
	const wantsLeast = /\b(least|lowest|smallest|fewest|bottom|min|minimum)\b/.test(text);

	// Parent rows when the question names them, e.g. "aisles" in "Aisle 12 · Tools".
	const parents = context.rows.filter((row) => row.has_children);
	const parentNoun = parents.length
		? normalizeText(cellText(parents[0].data[primaryColumn(columns).key])).split(' ')[0]
		: '';
	const onlyParents = !!parentNoun && parentNoun.length > 2 && new RegExp(` ${parentNoun}(s|es)? `).test(text);

	const metric =
		numericMentioned.find((column) => !filters.some((filter) => filter.column === column.key && filter.op !== 'eq')) ??
		mentioned.find((column) => !filters.some((filter) => filter.column === column.key) && (onlyParents ? parents : context.rows).some((row) => cellNumber(row.data[column.key]) !== null)) ??
		(wantsSum || wantsAvg || wantsMost || wantsLeast ? (visible.find((column) => column.data_type === 'currency') ?? visible.find(isNumericColumn)) : undefined);

	if (filters.length === 0 && !metric && !wantsCount) {
		const examples = suggestedQuestions(context);
		return {
			answer: `I couldn’t match that to this sheet’s columns or values. Try naming a column or an option${examples.length ? `, for example “${examples[0]}”` : ''}.`,
			steps,
			rows: [],
			caveat: null
		};
	}

	// No filters and a plain total or average: one aggregate over the whole sheet.
	if (filters.length === 0 && metric && (wantsSum || wantsAvg) && !onlyParents && isNumericColumn(metric)) {
		const operation = wantsAvg ? 'avg' : 'sum';
		const result = await tools.aggregate(operation, metric.key);
		steps.push({ tool: 'aggregate', args: `${operation}, ${metric.name}`, result: `${result.value === null ? 'no numbers' : formatValue(result.value, metric)} over ${plural(result.row_count, 'row')}` });
		return {
			answer: result.value === null ? `${metric.name} has no numbers to ${operation === 'sum' ? 'add up' : 'average'}.` : `The ${operation === 'avg' ? 'average' : 'total'} ${metric.name} is ${formatValue(result.value, metric)}, across ${plural(result.row_count, 'row')}.`,
			steps,
			rows: [],
			caveat: context.source === 'server' ? 'Formula columns use their cached values on the server.' : null
		};
	}

	// Filtered scan, then count / sum / rank the rows.
	let scanned: ContextRow[] = [];
	let total = 0;
	for (let offset = 0; offset < MAX_SCAN; offset += PAGE) {
		const page = await tools.queryRows({ offset, limit: PAGE, filter: filters, includeTotal: offset === 0 });
		if (offset === 0) total = page.total ?? page.rows.length;
		scanned = scanned.concat(page.rows);
		if (page.rows.length < PAGE) break;
	}
	steps.push({
		tool: 'filter_rows',
		args: filters.length ? filters.map((filter) => describeFilter(filter, names)).join(' and ') : 'all rows',
		result: `${plural(total, 'row')} match${total === 1 ? 'es' : ''}`
	});

	let pool = onlyParents ? scanned.filter((row) => row.has_children) : scanned;
	if (onlyParents) steps.push({ tool: 'keep_rows', args: `${parentNoun} rows (rows with children)`, result: plural(pool.length, 'row') });
	const caveat = total > scanned.length ? `Looked at the first ${scanned.length.toLocaleString()} of ${total.toLocaleString()} matching rows.` : null;
	const scope = filters.length ? ` with ${filters.map((filter) => describeFilter(filter, names)).join(' and ')}` : '';
	const noun = onlyParents ? `${parentNoun}${pool.length === 1 ? '' : 's'}` : pool.length === 1 ? 'row' : 'rows';

	if (metric && (wantsMost || wantsLeast)) {
		const ranked = pool
			.map((row) => ({ row, value: cellNumber(row.data[metric.key]) }))
			.filter((entry): entry is { row: ContextRow; value: number } => entry.value !== null)
			.sort((a, b) => (wantsLeast ? a.value - b.value : b.value - a.value));
		steps.push({ tool: 'rank', args: `${metric.name}, ${wantsLeast ? 'lowest' : 'highest'} first`, result: `top ${Math.min(5, ranked.length)}` });
		if (ranked.length === 0) return { answer: `No ${noun}${scope} have a number in ${metric.name}.`, steps, rows: [], caveat };
		const top = ranked.slice(0, 5);
		const list = top.map((entry) => `${rowLink(entry.row, columns).label} (${isNumericColumn(metric) ? formatValue(entry.value, metric) : cellText(entry.row.data[metric.key])})`).join(', ');
		return {
			answer: `${wantsLeast ? 'Lowest' : 'Highest'} ${metric.name}${scope}: ${list}.`,
			steps,
			rows: top.map((entry) => rowLink(entry.row, columns)),
			caveat
		};
	}

	if (metric && (wantsSum || wantsAvg) && isNumericColumn(metric)) {
		const values = pool.map((row) => cellNumber(row.data[metric.key])).filter((value): value is number => value !== null);
		const sum = values.reduce((acc, value) => acc + value, 0);
		const result = wantsAvg ? (values.length ? sum / values.length : 0) : sum;
		steps.push({ tool: wantsAvg ? 'average' : 'sum', args: metric.name, result: formatValue(result, metric) });
		return {
			answer: `The ${wantsAvg ? 'average' : 'total'} ${metric.name} for ${plural(pool.length, onlyParents ? parentNoun : 'row')}${scope} is ${formatValue(result, metric)}.`,
			steps,
			rows: pool.slice(0, 5).map((row) => rowLink(row, columns)),
			caveat
		};
	}

	const count = onlyParents ? pool.length : total;
	return {
		answer: `${count.toLocaleString()} ${noun}${scope}.`,
		steps,
		rows: pool.slice(0, 5).map((row) => rowLink(row, columns)),
		caveat: onlyParents ? caveat : null
	};
}
