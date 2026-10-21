import type { SheetContext, SheetTools, StatusReport } from '../types';
import { parseLooseDate, plural } from '../text';
import { cellNumber, cellText, formatValue, isDoneValue, isNumericColumn, isStatusColumn, percent, primaryColumn, todayIso } from './shared';

export async function statusReport(context: SheetContext, tools: SheetTools): Promise<StatusReport> {
	const { columns, rows } = context;
	const today = todayIso();
	const dateLabel = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
	const primary = primaryColumn(columns);
	const status = columns.find(isStatusColumn) ?? columns.find((column) => column.data_type === 'enum');
	const owner = columns.find((column) => column.data_type === 'user') ?? columns.find((column) => /owner|assignee|responsible|paid by/i.test(column.name));
	const due = columns.find((column) => column.data_type === 'date' && /due|deadline|close|end/i.test(column.name));
	const money = columns.filter((column) => (column.data_type === 'currency' || (isNumericColumn(column) && column.settings.format === 'currency')) && column.data_type !== 'protected').slice(0, 3);
	const leaves = rows.filter((row) => !row.has_children);
	const sections: string[] = [];
	const sampleNote = context.sampled ? ` (from the first ${rows.length.toLocaleString()} rows)` : '';

	sections.push(`${context.name}: status update, ${dateLabel}`);

	// Headline numbers.
	const headline: string[] = [`• ${plural(context.rowCount, 'row')} in the sheet.`];
	for (const column of money) {
		if (column.data_type === 'currency') {
			const sum = await tools.aggregate('sum', column.key);
			if (sum.value !== null) headline.push(`• Total ${column.name}: ${formatValue(sum.value, column)}.`);
		} else {
			const values = leaves.map((row) => cellNumber(row.data[column.key])).filter((value): value is number => value !== null);
			// Formula results are cached as rows are calculated; a total over mostly-missing values would mislead.
			if (values.length > 0 && values.length >= leaves.length * 0.5) {
				headline.push(`• Total ${column.name}${sampleNote}: ${formatValue(values.reduce((a, b) => a + b, 0), column)}.`);
			}
		}
	}
	sections.push(`Headlines\n${headline.join('\n')}`);

	// Status breakdown.
	if (status) {
		const counts = new Map<string, number>();
		for (const row of leaves) {
			const value = cellText(row.data[status.key]) || 'Not set';
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
		const done = [...counts.entries()].filter(([value]) => isDoneValue(value)).reduce((sum, [, count]) => sum + count, 0);
		const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => `• ${value}: ${count.toLocaleString()} (${percent(count, leaves.length)})`);
		sections.push(`By ${status.name}${sampleNote}\n${lines.join('\n')}${done ? `\n\n${percent(done, leaves.length)} finished overall.` : ''}`);
	}

	// Progress per parent row.
	const parents = rows.filter((row) => row.has_children && row.depth === 0);
	if (parents.length && status) {
		const lines = parents.slice(0, 8).map((parent) => {
			const children = rows.filter((row) => row.parent_id === parent.id);
			const finished = children.filter((row) => isDoneValue(cellText(row.data[status.key]))).length;
			return `• ${cellText(parent.data[primary.key]) || `Row ${parent.position}`}: ${finished} of ${children.length} done (${percent(finished, children.length)})`;
		});
		const noun = cellText(parents[0].data[primary.key]).match(/^[A-Za-z]+/)?.[0]?.toLowerCase() ?? 'group';
		sections.push(`Progress by ${noun}\n${lines.join('\n')}`);
	}

	// At risk.
	if (due) {
		const atRisk = leaves
			.filter((row) => {
				const day = parseLooseDate(cellText(row.data[due.key]))?.iso;
				const state = status ? cellText(row.data[status.key]) : '';
				return day && day < today && !isDoneValue(state);
			})
			.slice(0, 6);
		if (atRisk.length) {
			const lines = atRisk.map((row) => {
				const who = owner ? cellText(row.data[owner.key]) : '';
				return `• ${cellText(row.data[primary.key]) || `Row ${row.position}`}: ${due.name.toLowerCase()} ${cellText(row.data[due.key])}${status ? `, ${cellText(row.data[status.key]) || 'no status'}` : ''}${who ? ` (${who})` : ''}`;
			});
			sections.push(`Needs attention\n${lines.join('\n')}`);
		} else {
			sections.push('Needs attention\n• Nothing is past its due date.');
		}
	}

	// Next steps.
	const next: string[] = [];
	if (due && sections.some((section) => section.startsWith('Needs attention\n•') && !section.includes('Nothing is past'))) next.push('• Chase the overdue items above with their owners.');
	if (status) {
		const blocked = leaves.filter((row) => /block|disput|hold|risk/i.test(cellText(row.data[status.key]))).length;
		if (blocked) next.push(`• Unblock ${plural(blocked, 'item')} that ${blocked === 1 ? 'is' : 'are'} blocked, disputed or on hold.`);
	}
	if (!next.length) next.push('• No blockers found. Keep the current plan.');
	sections.push(`Next steps\n${next.join('\n')}`);

	return { title: `${context.name} status update`, body: sections.join('\n\n') };
}
