import { PROTECTED_MASK } from '@/lib/grid/cell-text';
import { cellPrimitive, isFormulaCell, type CellValue, type Column } from '@/lib/types';
import type { ContextRow, RowLink } from '../types';
import { normalizeText, parseLooseNumber } from '../text';

/** Number and currency columns, and text columns formatted as numbers (formula columns). */
export function isNumericColumn(column: Column): boolean {
	if (column.data_type === 'number' || column.data_type === 'currency') return true;
	return column.data_type === 'text' && ['number', 'currency', 'percent'].includes(String(column.settings.format ?? ''));
}

/** Display-ish text for a stored value; formula cells use their cached result. */
export function cellText(value: CellValue | undefined): string {
	if (value === undefined || value === null) return '';
	if (isFormulaCell(value)) return value.value === null || value.value === undefined ? '' : String(value.value);
	const primitive = cellPrimitive(value);
	return primitive === null ? '' : String(primitive);
}

/** Numeric reading of a cell: numbers, cached formula numbers, "1,250.00", or a leading count like "8 to reorder". */
export function cellNumber(value: CellValue | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'number') return value;
	const text = cellText(value);
	if (!text || text === PROTECTED_MASK) return null;
	const direct = parseLooseNumber(text);
	if (direct !== null) return direct;
	const leading = text.match(/^\s*(-?\d[\d,]*(?:\.\d+)?)\b/);
	return leading ? Number(leading[1].replace(/,/g, '')) : null;
}

export function isFormulaValue(value: CellValue | undefined): value is { formula: string; value: string | number | boolean | null } {
	return value !== undefined && value !== null && isFormulaCell(value);
}

export function primaryColumn(columns: Column[]): Column {
	return columns.find((column) => column.settings.primary) ?? columns[0];
}

export function rowLabel(row: ContextRow, columns: Column[]): string {
	const text = cellText(row.data[primaryColumn(columns)?.key ?? '']);
	return text ? text : `Row ${row.position}`;
}

export function rowLink(row: ContextRow, columns: Column[]): RowLink {
	return { id: row.id, position: row.position, label: rowLabel(row, columns) };
}

/**
 * Columns mentioned in free text, ordered by where they first appear. Full
 * names win; otherwise a distinctive word of the name ("reorder" for
 * "Reorder Status") counts.
 */
export function columnsInText(text: string, columns: Column[]): Column[] {
	const haystack = ` ${normalizeText(text)} `;
	const full: { column: Column; at: number }[] = [];
	const partial: { column: Column; at: number }[] = [];

	for (const column of columns) {
		const name = normalizeText(column.name);
		if (!name) continue;
		const variants = [name, name.endsWith('s') ? name.slice(0, -1) : `${name}s`];
		const at = Math.min(...variants.map((variant) => haystack.indexOf(` ${variant} `)).filter((index) => index >= 0), Infinity);
		if (at !== Infinity) {
			full.push({ column, at });
			continue;
		}
		const words = name.split(' ').filter((word) => word.length > 3 && !['date', 'name', 'level', 'status', 'value'].includes(word));
		const wordAt = Math.min(...words.map((word) => haystack.search(new RegExp(` ${word}(s|es)? `))).filter((index) => index >= 0), Infinity);
		if (wordAt !== Infinity) partial.push({ column, at: wordAt });
	}

	// Drop full matches contained in a longer full match at the same spot ("Price" inside "Unit Price").
	const kept = full.filter(
		(candidate) =>
			!full.some(
				(other) =>
					other !== candidate &&
					normalizeText(other.column.name).includes(normalizeText(candidate.column.name)) &&
					other.column.name.length > candidate.column.name.length
			)
	);
	const chosen = kept.length > 0 ? [...kept, ...partial.filter((p) => !kept.some((k) => k.column.key === p.column.key))] : partial;
	return chosen.sort((a, b) => a.at - b.at).map((entry) => entry.column);
}

const DONE = /\b(done|complete|completed|closed|paid|won|resolved|delivered|finished|approved|shipped)\b/i;

export function isDoneValue(value: string): boolean {
	return DONE.test(value);
}

export function isStatusColumn(column: Column): boolean {
	return column.data_type === 'enum' && /status|stage|state|progress/i.test(column.name);
}

export function todayIso(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function formatValue(value: number, column?: Column): string {
	if (column && (column.data_type === 'currency' || column.settings.format === 'currency')) {
		const currency = String(column.settings.currency ?? 'USD');
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
		} catch {
			return `${currency} ${value.toLocaleString()}`;
		}
	}
	return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function percent(part: number, whole: number): string {
	return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}
