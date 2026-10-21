import type { CellValue, Column, DrilldownItem } from '@/lib/types';
import { isFormulaCell } from '@/lib/types';
import { isSafeImageUrl, splitList } from '@/lib/utils/cell-values';

const TRUE_WORDS = /^(true|yes|y|1|x|✓|checked)$/i;
const FALSE_WORDS = /^(false|no|n|0|unchecked)$/i;

export type ParsedInput = { ok: true; value: CellValue } | { ok: false; reason: string };

const accept = (value: CellValue): ParsedInput => ({ ok: true, value });
const reject = (reason: string): ParsedInput => ({ ok: false, reason });

/**
 * Converts what a user typed into a stored cell value for the column's type.
 * Input starting with "=" is always a formula. Free-form types keep values
 * that don't fit as text; enum, image and drilldown columns reject invalid input.
 */
export function parseCellInput(column: Column, raw: string): ParsedInput {
	const text = raw.trim();
	if (text === '') return accept(null);
	if (text.startsWith('=') && text.length > 1) return accept({ formula: text, value: null });

	switch (column.data_type) {
		case 'number':
		case 'currency': {
			const cleaned = text.replace(/[,\s$€£¥₦]/g, '').replace(/%$/, '');
			const n = Number(cleaned);
			return accept(cleaned !== '' && Number.isFinite(n) ? n : text);
		}
		case 'boolean':
			if (TRUE_WORDS.test(text)) return accept(true);
			if (FALSE_WORDS.test(text)) return accept(false);
			return accept(text);
		case 'date':
			return accept(parseDate(text) ?? text);
		case 'enum': {
			const option = column.settings.options?.find((candidate) => candidate.value.toLowerCase() === text.toLowerCase());
			return option ? accept(option.value) : reject(`"${text}" is not an option for ${column.name}`);
		}
		case 'bubble':
			return accept(splitList(text));
		case 'image': {
			const urls = splitList(text);
			const invalid = urls.find((url) => !isSafeImageUrl(url));
			return invalid ? reject(`"${invalid}" is not an http(s) image URL`) : accept(urls);
		}
		case 'drilldown': {
			const items: DrilldownItem[] = [];
			for (const entry of splitList(text)) {
				const [label, img] = entry.split('|').map((part) => part.trim());
				if (!label) continue;
				if (img && !isSafeImageUrl(img)) return reject(`"${img}" is not an http(s) image URL`);
				items.push(img ? { text: label, img } : { text: label });
			}
			return accept(items);
		}
		case 'user': {
			const users = column.settings.users ?? {};
			const match = Object.entries(users).find(
				([id, user]) => id === text || user.name.toLowerCase() === text.toLowerCase()
			);
			return accept(match ? match[0] : text);
		}
		case 'markdown':
			return accept(raw.replace(/\s+$/, ''));
		default:
			// text, uri, row-id, protected
			return accept(text);
	}
}

/** The editable text for a stored value (formula source for formula cells). */
export function cellInputText(value: CellValue | undefined): string {
	if (value === undefined || value === null) return '';
	if (isFormulaCell(value)) return value.formula;
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === 'string' ? item : item.img ? `${item.text} | ${item.img}` : item.text))
			.join(', ');
	}
	return String(value);
}

function parseDate(text: string): string | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
	const time = Date.parse(text);
	if (Number.isNaN(time)) return null;
	const date = new Date(time);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
