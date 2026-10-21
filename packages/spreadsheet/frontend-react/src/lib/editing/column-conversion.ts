import type { CellValue, Column } from '@/lib/types';
import { isEmptyCellValue, isFormulaCell } from '@/lib/types';
import { isSafeImageUrl, toStringList } from '@/lib/utils/cell-values';
import { cellInputText, parseCellInput } from './cell-input';

/**
 * Converts a stored value when its column changes type, by re-reading the
 * value's text as input for the new type. Formulas are kept as they are.
 * Returns `undefined` when the value cannot be represented in the new type.
 */
export function convertCellValue(value: CellValue, to: Column): CellValue | undefined {
	if (isEmptyCellValue(value) || isFormulaCell(value)) return value;

	const parsed = parseCellInput(to, cellInputText(value));
	if (parsed.ok) return parsed.value;

	// Keep whatever part of a list is still valid (e.g. only the http(s) image URLs).
	if (to.data_type === 'image') {
		const urls = toStringList(value).filter(isSafeImageUrl);
		return urls.length > 0 ? urls : undefined;
	}
	return undefined;
}

/**
 * Rewrites `[Old Name]` references in a formula after a column rename. Column
 * names cannot contain brackets, so a bracketed match is always a reference;
 * row suffixes such as `@row`, `12` or `:[Old Name]` are preserved.
 */
export function renameFormulaReferences(formula: string, oldName: string, newName: string): string {
	return formula.replace(columnReferencePattern(oldName, 'gi'), `[${newName}]`);
}

/** Whether a formula references the column `name` (in any form: @row, ranges, CHILDREN…). */
export function formulaReferencesColumn(formula: string, name: string): boolean {
	return columnReferencePattern(name, 'i').test(formula);
}

function columnReferencePattern(name: string, flags: string): RegExp {
	const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\[\\s*${escaped}\\s*\\]`, flags);
}
