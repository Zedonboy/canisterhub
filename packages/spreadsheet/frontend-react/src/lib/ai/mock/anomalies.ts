import type { Insight, SheetContext } from '../types';
import { companyKey, median, parseLooseDate, plural } from '../text';
import { cellNumber, cellText, formatValue, isDoneValue, isNumericColumn, isStatusColumn, primaryColumn, rowLabel, rowLink, todayIso } from './shared';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function findAnomalies(context: SheetContext): Insight[] {
	const { columns, rows } = context;
	const insights: Insight[] = [];
	// Leaf rows only, and never a "Total" row, which is naturally far larger than the rest.
	const leaves = rows.filter((row) => !row.has_children && !/^(sub|grand )?total\b/i.test(rowLabel(row, columns)));
	const numeric = columns.filter((column) => isNumericColumn(column) && column.data_type !== 'protected');

	// Outliers per numeric column (median absolute deviation).
	for (const column of numeric) {
		const values = leaves.map((row) => ({ row, value: cellNumber(row.data[column.key]) })).filter((entry): entry is { row: (typeof leaves)[number]; value: number } => entry.value !== null);
		if (values.length < 8) continue;
		const mid = median(values.map((entry) => entry.value));
		const mad = median(values.map((entry) => Math.abs(entry.value - mid)));
		if (mad === 0) continue;
		const outliers = values
			.map((entry) => ({ ...entry, z: (0.6745 * (entry.value - mid)) / mad }))
			.filter((entry) => Math.abs(entry.z) > 3.5)
			.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
		if (outliers.length === 0 || outliers.length > values.length * 0.1) continue;
		const top = outliers[0];
		insights.push({
			id: `outlier:${column.key}`,
			severity: Math.abs(top.z) > 8 ? 'high' : 'medium',
			title: `${plural(outliers.length, 'unusual value')} in ${column.name}`,
			detail: `${rowLink(top.row, columns).label} has ${formatValue(top.value, column)}, about ${Math.max(2, Math.round(top.value / (mid || 1)))}× the typical ${formatValue(mid, column)}.`,
			rows: outliers.slice(0, 8).map((entry) => rowLink(entry.row, columns))
		});
	}

	// Possible duplicates: same name, amount and date.
	const primary = primaryColumn(columns);
	const amount = columns.find((column) => column.data_type === 'currency') ?? numeric[0];
	const date = columns.find((column) => column.data_type === 'date');
	if (primary && amount) {
		const seen = new Map<string, (typeof leaves)[number][]>();
		for (const row of leaves) {
			const value = cellNumber(row.data[amount.key]);
			const name = companyKey(cellText(row.data[primary.key]));
			if (value === null || !name) continue;
			const day = date ? (parseLooseDate(cellText(row.data[date.key]))?.iso ?? cellText(row.data[date.key])) : '';
			const key = `${name}|${value}|${day}`;
			seen.set(key, [...(seen.get(key) ?? []), row]);
		}
		const duplicates = [...seen.values()].filter((group) => group.length > 1);
		if (duplicates.length > 0) {
			const extra = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
			const first = duplicates[0];
			insights.push({
				id: 'duplicates',
				severity: 'high',
				title: `${plural(extra, 'possible duplicate')}`,
				detail: `${rowLink(first[0], columns).label} appears ${first.length} times with ${formatValue(cellNumber(first[0].data[amount.key]) ?? 0, amount)}${date ? ' on the same date' : ''}. Check for a double payment or entry.`,
				rows: duplicates.flat().slice(0, 10).map((row) => rowLink(row, columns))
			});
		}
	}

	// Below a threshold column, e.g. Quantity under Reorder Level.
	const quantity = numeric.find((column) => /qty|quantity|stock|on hand|units/i.test(column.name));
	const threshold = numeric.find((column) => column !== quantity && /reorder|minimum|min\b|threshold|limit|par level/i.test(column.name));
	if (quantity && threshold) {
		const low = leaves
			.map((row) => ({ row, qty: cellNumber(row.data[quantity.key]), min: cellNumber(row.data[threshold.key]) }))
			.filter((entry) => entry.qty !== null && entry.min !== null && entry.min > 0 && entry.qty < entry.min * 0.05);
		if (low.length > 0) {
			insights.push({
				id: 'critical-stock',
				severity: 'high',
				title: `${plural(low.length, 'item')} almost out of stock`,
				detail: `${quantity.name} is under 5% of ${threshold.name}${context.sampled ? ` in the ${rows.length.toLocaleString()} rows checked` : ''}. These run out before a normal reorder arrives.`,
				rows: low.slice(0, 10).map((entry) => rowLink(entry.row, columns))
			});
		}
	}

	// Actual over planned.
	const planned = numeric.find((column) => /planned|budget|target/i.test(column.name));
	const actual = numeric.find((column) => /actual|spent|spend/i.test(column.name));
	if (planned && actual) {
		const over = leaves.filter((row) => {
			const p = cellNumber(row.data[planned.key]);
			const a = cellNumber(row.data[actual.key]);
			return p !== null && a !== null && p > 0 && a > p * 1.1;
		});
		if (over.length > 0) {
			insights.push({
				id: 'over-budget',
				severity: 'medium',
				title: `${plural(over.length, 'line')} more than 10% over ${planned.name}`,
				detail: `${actual.name} runs ahead of ${planned.name} on these lines.`,
				rows: over.slice(0, 10).map((row) => rowLink(row, columns))
			});
		}
	}

	// Past due and not done.
	const due = columns.find((column) => column.data_type === 'date' && /due|deadline|close/i.test(column.name));
	const status = columns.find(isStatusColumn);
	if (due && status) {
		const today = todayIso();
		const overdue = leaves.filter((row) => {
			const day = parseLooseDate(cellText(row.data[due.key]))?.iso;
			const state = cellText(row.data[status.key]);
			return day && day < today && state && !isDoneValue(state);
		});
		if (overdue.length > 0) {
			insights.push({
				id: 'overdue',
				severity: overdue.length > 5 ? 'high' : 'medium',
				title: `${plural(overdue.length, 'item')} past ${due.name} and not finished`,
				detail: `${status.name} isn’t done for rows whose ${due.name} has passed.`,
				rows: overdue.slice(0, 10).map((row) => rowLink(row, columns))
			});
		}
	}

	// Rows with no name.
	if (primary) {
		const blank = leaves.filter((row) => !cellText(row.data[primary.key]) && Object.keys(row.data).length > 0);
		if (blank.length > 0) {
			insights.push({
				id: 'blank-primary',
				severity: 'low',
				title: `${plural(blank.length, 'row')} with no ${primary.name}`,
				detail: 'Rows without a name are easy to miss in filters and reports.',
				rows: blank.slice(0, 10).map((row) => rowLink(row, columns))
			});
		}
	}

	return insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
