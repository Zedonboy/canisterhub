import type { FormulaResult } from '@/lib/formulas/formula-types';
import type { CellPrimitive, CellValue, Column } from '@/lib/types';
import { cellPrimitive, isFormulaCell } from '@/lib/types';
import { formatCurrency, formatDate, formatNumber, formatPercent } from '@/lib/utils/format';

export type DisplayFormat = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean' | 'user' | 'auto';

/** Shown instead of the value of protected cells (grid, search, formula bar). */
export const PROTECTED_MASK = '••••••';

export function displayFormat(column: Column): DisplayFormat {
	switch (column.data_type) {
		case 'number':
		case 'currency':
		case 'date':
		case 'boolean':
		case 'user':
			return column.data_type as DisplayFormat;
		case 'text':
			// Text cells may hold formulas; their results use the column's format.
			return column.settings.format ?? 'auto';
		case 'enum':
		case 'uri':
		case 'image':
		case 'markdown':
		case 'bubble':
		case 'drilldown':
		case 'row-id':
		case 'protected':
			return 'text';
		default:
			return 'auto';
	}
}

export function formatPrimitive(column: Column, value: CellPrimitive, format = displayFormat(column)): string {
	if (value === null || value === '') return '';
	const { settings } = column;

	if (typeof value === 'number') {
		switch (format) {
			case 'currency':
				return formatCurrency(value, settings.currency ?? 'USD', settings.decimals ?? 2);
			case 'percent':
				return formatPercent(value, settings.decimals ?? 1);
			case 'number':
			case 'auto':
				return formatNumber(value, {
					decimals: settings.decimals,
					prefix: settings.prefix,
					suffix: settings.suffix
				});
			default:
				return String(value);
		}
	}

	if (typeof value === 'boolean') return value ? 'Yes' : 'No';

	if (format === 'date') return formatDate(value);
	if (format === 'user') return settings.users?.[value]?.name ?? value;
	return value;
}

/** Text shown for a cell, used by renderers, copy and search. */
export function cellDisplayText(column: Column, value: CellValue | undefined, formula?: FormulaResult): string {
	if (column.data_type === 'protected') {
		return cellPrimitive(value) === null ? '' : PROTECTED_MASK;
	}
	if (isFormulaCell(value)) {
		const result = formula;
		if (result?.state === 'error' && result.error) return result.error.code;
		return formatPrimitive(column, result ? result.value : (value.value ?? null));
	}
	return formatPrimitive(column, cellPrimitive(value));
}

export function isNumericFormat(format: DisplayFormat): boolean {
	return format === 'number' || format === 'currency' || format === 'percent';
}
