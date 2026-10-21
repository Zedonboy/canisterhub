import { columnTypeLabel } from '@/lib/storage/sheet-schema';
import type { SheetBrief, SheetContext } from '../types';
import { plural } from '../text';
import { explainFormula } from './formula';
import { cellText, isFormulaValue, primaryColumn } from './shared';

export function explainSheet(context: SheetContext): SheetBrief {
	const { columns, rows, rowCount } = context;
	const primary = primaryColumn(columns);
	const parents = rows.filter((row) => row.has_children);
	const childCounts = parents.map((parent) => rows.filter((row) => row.parent_id === parent.id).length);
	const statusColumn = columns.find((column) => column.data_type === 'enum');
	const money = columns.filter((column) => column.data_type === 'currency' || column.settings.format === 'currency');
	const sections: SheetBrief['sections'] = [];

	// Purpose.
	const subject = primary ? primary.name.toLowerCase() : 'item';
	const purposeBits = [`${context.name} holds ${plural(rowCount, 'row')}, one per ${subject}`];
	if (money.length) purposeBits.push(`with money tracked in ${money.map((column) => column.name).join(' and ')}`);
	if (statusColumn) purposeBits.push(`and progress in ${statusColumn.name}`);
	let purpose = `${purposeBits.join(', ')}.`;
	if (context.description) purpose = `${context.description.replace(/\.?$/, '.')} ${purpose}`;

	// Columns.
	sections.push({
		title: 'Columns',
		items: columns.map((column) => {
			const type = column.data_type === 'text' && column.settings.format ? `${column.settings.format} (text)` : columnTypeLabel(column.data_type);
			const bits = [`${column.name} — ${type}`];
			if (column.settings.primary) bits.push('the primary column');
			if (column.settings.options?.length) bits.push(`choices: ${column.settings.options.map((option) => option.value).join(', ')}`);
			if (column.settings.column_formula) bits.push(`calculated for every row: ${explainFormula(column.settings.column_formula, columns).summary.replace(/\.$/, '')}`);
			if (column.data_type === 'protected') bits.push('values are masked and never sent to AI');
			if (column.settings.column_group) bits.push(`in the “${column.settings.column_group}” group`);
			return bits.join('; ');
		})
	});

	// Calculations found in the rows.
	const calculations: string[] = [];
	for (const column of columns) {
		if (column.settings.column_formula) continue;
		const byFormula = new Map<string, { parents: number; children: number; other: number }>();
		for (const row of rows) {
			const value = row.data[column.key];
			if (!isFormulaValue(value)) continue;
			const entry = byFormula.get(value.formula) ?? { parents: 0, children: 0, other: 0 };
			if (row.has_children) entry.parents++;
			else if (row.depth > 0) entry.children++;
			else entry.other++;
			byFormula.set(value.formula, entry);
		}
		for (const [formula, where] of [...byFormula.entries()].sort((a, b) => b[1].parents + b[1].children + b[1].other - (a[1].parents + a[1].children + a[1].other)).slice(0, 3)) {
			const place = where.parents && !where.children && !where.other ? 'On parent rows' : where.children && !where.parents ? 'On child rows' : `In ${plural(where.parents + where.children + where.other, 'row')}`;
			calculations.push(`${place}, ${column.name} = ${formula} — ${explainFormula(formula, columns).summary}`);
		}
	}
	if (calculations.length) sections.push({ title: 'How the numbers are calculated', items: calculations });

	// Structure.
	const structure: string[] = [];
	if (parents.length) {
		const average = Math.round(childCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, parents.length));
		const example = cellText(parents[0].data[primary.key]);
		structure.push(`Rows are nested: parent rows such as “${example}” group about ${average} child rows each.`);
		structure.push('Formulas using CHILDREN() on a parent row roll up its children, so parent totals change when child rows are edited, added or indented.');
	} else {
		structure.push('Every row is at the same level; there are no nested rows.');
	}
	const groups = [...new Set(columns.map((column) => column.settings.column_group).filter(Boolean))];
	if (groups.length) structure.push(`Column groups: ${groups.join(', ')}.`);
	structure.push(context.writable ? 'This sheet is stored in this browser and can be edited.' : 'This sheet comes from the server and is view only.');
	sections.push({ title: 'Structure', items: structure });

	// Watch out for.
	const watch: string[] = [];
	for (const row of rows) {
		for (const column of columns) {
			const value = row.data[column.key];
			if (!isFormulaValue(value)) continue;
			const range = value.formula.match(/\[([^\]]+)\](\d+):\[\1\](\d+)/);
			if (range && Number(range[3]) >= rowCount - 1) {
				watch.push(`Row ${row.position.toLocaleString()} (${column.name}) uses the fixed range ${range[0]}, which will miss rows added later. Run the Audit tab for a fix.`);
			}
		}
		if (watch.length >= 3) break;
	}
	if (context.sampled) watch.push(`This brief is based on the first ${rows.length.toLocaleString()} rows.`);
	if (watch.length) sections.push({ title: 'Watch out for', items: watch });

	return { purpose, sections };
}
