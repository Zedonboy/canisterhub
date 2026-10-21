import type { CellUpdate } from '@/lib/storage';
import type { AuditFinding, ContextRow, SheetContext } from '../types';
import { closestColumn, plural, referencedColumnNames } from '../text';
import { cellNumber, cellText, isFormulaValue, isNumericColumn } from './shared';

const ERROR_CODE = /^#(REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!|CYCLE!|PARSE!)$/;

type Cell = AuditFinding['cells'][number];

const cellOf = (row: ContextRow, columnKey: string): Cell => ({ rowId: row.id, position: row.position, columnKey });

export function auditFormulas(context: SheetContext): AuditFinding[] {
	const { columns, rows, rowCount, writable } = context;
	const findings: AuditFinding[] = [];
	const names = new Set(columns.map((column) => column.name));

	for (const column of columns) {
		const locked = !!column.settings.column_formula;
		const fixable = writable && !locked;
		const formulaRows = rows.filter((row) => isFormulaValue(row.data[column.key]));
		const formulaOf = (row: ContextRow) => (row.data[column.key] as { formula: string }).formula;

		// Fixed ranges that end at (or just before) the last row.
		const stale = formulaRows.flatMap((row) => {
			const formula = formulaOf(row);
			const match = [...formula.matchAll(/\[([^\]]+)\](\d+):\[\1\](\d+)/g)].find((m) => Number(m[3]) >= rowCount - 1);
			return match ? [{ row, formula, match }] : [];
		});
		if (stale.length > 0) {
			const example = stale[0];
			findings.push({
				id: `stale-range:${column.key}`,
				severity: 'high',
				title: `Fixed range will miss new rows in ${column.name}`,
				detail: `Row ${example.row.position.toLocaleString()} uses ${example.match[0]}, which stops at row ${Number(example.match[3]).toLocaleString()} of ${rowCount.toLocaleString()}. Rows added later are left out. A whole-column range, [${example.match[1]}]:[${example.match[1]}], includes them.`,
				cells: stale.slice(0, 50).map((entry) => cellOf(entry.row, column.key)),
				fix: fixable
					? {
							label: 'Use whole-column ranges',
							updates: stale.map(({ row, formula }) => ({
								rowId: row.id,
								columnKey: column.key,
								value: { formula: formula.replace(/\[([^\]]+)\]\d+:\[\1\]\d+/g, '[$1]:[$1]'), value: null }
							}))
						}
					: undefined
			});
		}

		// References to columns that don't exist.
		const broken = formulaRows.flatMap((row) => {
			const missing = referencedColumnNames(formulaOf(row)).filter((name) => !names.has(name));
			return missing.length ? [{ row, missing }] : [];
		});
		if (broken.length > 0) {
			const missingName = broken[0].missing[0];
			const replacement = closestColumn(missingName, columns, 0.45);
			findings.push({
				id: `missing-column:${column.key}`,
				severity: 'high',
				title: `${column.name} refers to a column that doesn’t exist`,
				detail: `${plural(broken.length, 'formula')} use [${missingName}], so they show #REF!.${replacement ? ` The closest column is ${replacement.name}.` : ''}`,
				cells: broken.slice(0, 50).map((entry) => cellOf(entry.row, column.key)),
				fix:
					fixable && replacement
						? {
								label: `Point them at [${replacement.name}]`,
								updates: broken.map(({ row }) => ({
									rowId: row.id,
									columnKey: column.key,
									value: { formula: formulaOf(row).split(`[${missingName}]`).join(`[${replacement.name}]`), value: null }
								}))
							}
						: undefined
			});
		}

		// Cached errors.
		const errored = formulaRows.filter((row) => ERROR_CODE.test(String((row.data[column.key] as { value: unknown }).value ?? '')));
		if (errored.length > 0 && broken.length === 0) {
			findings.push({
				id: `errors:${column.key}`,
				severity: 'high',
				title: `${plural(errored.length, 'formula')} in ${column.name} ${errored.length === 1 ? 'returns' : 'return'} an error`,
				detail: `The first is row ${errored[0].position.toLocaleString()}, showing ${String((errored[0].data[column.key] as { value: unknown }).value)}. Select it and use the formula bar’s AI Fix.`,
				cells: errored.slice(0, 50).map((row) => cellOf(row, column.key))
			});
		}

		// Inconsistent formulas and typed-over values, compared among rows at the same level.
		if (locked) continue;
		for (const level of [0, 1, 2, 3]) {
			const peers = rows.filter((row) => row.depth === level && !(row.position === 1 && rows.length > 2 && level === 0 && row.has_children === false && rows[1]?.has_children));
			const filled = peers.filter((row) => cellText(row.data[column.key]) !== '' || isFormulaValue(row.data[column.key]));
			const withFormula = filled.filter((row) => isFormulaValue(row.data[column.key]));
			if (withFormula.length < 4 || withFormula.length < filled.length * 0.6) continue;

			const counts = new Map<string, number>();
			for (const row of withFormula) counts.set(formulaOf(row), (counts.get(formulaOf(row)) ?? 0) + 1);
			const [majority, majorityCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
			if (majorityCount < withFormula.length * 0.6) continue;

			const different = withFormula.filter((row) => formulaOf(row) !== majority && !/\]\d+/.test(formulaOf(row)));
			if (different.length > 0 && different.length <= Math.max(3, withFormula.length * 0.2)) {
				const updates: CellUpdate[] = different.map((row) => ({ rowId: row.id, columnKey: column.key, value: { formula: majority, value: null } }));
				findings.push({
					id: `inconsistent:${column.key}:${level}`,
					severity: 'medium',
					title: `${plural(different.length, 'row')} in ${column.name} ${different.length === 1 ? 'uses' : 'use'} a different formula`,
					detail: `${majorityCount.toLocaleString()} rows use ${majority}; row ${different[0].position.toLocaleString()} uses ${formulaOf(different[0])}. A one-off formula is often a copy-paste mistake.`,
					cells: different.slice(0, 50).map((row) => cellOf(row, column.key)),
					fix: fixable ? { label: `Use ${majority}`, updates } : undefined
				});
			}

			const typed = filled.filter((row) => !isFormulaValue(row.data[column.key]) && cellNumber(row.data[column.key]) !== null);
			if (typed.length > 0 && typed.length <= Math.max(3, filled.length * 0.25) && isNumericColumn(column) === isNumericColumn(column)) {
				findings.push({
					id: `hardcoded:${column.key}:${level}`,
					severity: 'medium',
					title: `${plural(typed.length, 'typed-in number')} where ${column.name} is calculated`,
					detail: `Row ${typed[0].position.toLocaleString()} holds ${cellText(typed[0].data[column.key])} instead of ${majority}. It won’t update when its inputs change.`,
					cells: typed.slice(0, 50).map((row) => cellOf(row, column.key)),
					fix: fixable
						? { label: `Restore ${majority}`, updates: typed.map((row) => ({ rowId: row.id, columnKey: column.key, value: { formula: majority, value: null } })) }
						: undefined
				});
			}

			if (different.length === 0 && typed.length === 0 && withFormula.length === peers.length && peers.length >= 10 && level === 0 && !rows.some((row) => row.depth > 0)) {
				findings.push({
					id: `column-formula:${column.key}`,
					severity: 'low',
					title: `${column.name} could be a column formula`,
					detail: `Every row uses ${majority}. As a column formula (Edit column → Column formula) new rows get it automatically and nobody can type over it.`,
					cells: []
				});
			}
		}

		// Division by a column that is zero in some rows.
		const divisions = formulaRows.filter((row) => /\/\s*\[([^\]]+)\]/.test(formulaOf(row)) && !/IF\(|IFERROR\(/.test(formulaOf(row)));
		const divisor = divisions.length ? formulaOf(divisions[0]).match(/\/\s*\[([^\]]+)\]/)?.[1] : undefined;
		const divisorColumn = columns.find((candidate) => candidate.name === divisor);
		if (divisorColumn) {
			const zero = divisions.filter((row) => cellNumber(row.data[divisorColumn.key]) === 0);
			if (zero.length > 0) {
				findings.push({
					id: `div-zero:${column.key}`,
					severity: 'medium',
					title: `${column.name} divides by zero in ${plural(zero.length, 'row')}`,
					detail: `${divisorColumn.name} is 0 in these rows, so they show #DIV/0!.`,
					cells: zero.slice(0, 50).map((row) => cellOf(row, column.key)),
					fix: fixable
						? {
								label: 'Show 0 instead of an error',
								updates: zero.map((row) => ({ rowId: row.id, columnKey: column.key, value: { formula: `=IFERROR(${formulaOf(row).replace(/^=/, '')}, 0)`, value: null } }))
							}
						: undefined
				});
			}
		}
	}

	const order = { high: 0, medium: 1, low: 2 } as const;
	return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
