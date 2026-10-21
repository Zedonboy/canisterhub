/**
 * Text helpers shared by the mock AI: normalising, fuzzy matching and loose
 * parsing of the numbers and dates people type into spreadsheets.
 */

import type { Column } from '@/lib/types';

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lowercase, accents and punctuation removed, whitespace collapsed. */
export function normalizeText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

const COMPANY_SUFFIXES = new Set([
	'ltd',
	'limited',
	'inc',
	'incorporated',
	'llc',
	'plc',
	'co',
	'company',
	'corp',
	'corporation',
	'gmbh',
	'the'
]);

/** Key that treats "ACME Limited", "Acme Ltd." and "acme ltd" as the same organisation. */
export function companyKey(value: string): string {
	return normalizeText(value)
		.split(' ')
		.filter((word) => word && !COMPANY_SUFFIXES.has(word))
		.join(' ');
}

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return previous[b.length];
}

/** 0..1 similarity of two strings after normalising. */
export function similarity(a: string, b: string): number {
	const x = normalizeText(a);
	const y = normalizeText(b);
	if (!x && !y) return 1;
	const longest = Math.max(x.length, y.length);
	return longest === 0 ? 0 : 1 - levenshtein(x, y) / longest;
}

export function tokens(value: string): string[] {
	return normalizeText(value).split(' ').filter(Boolean);
}

/** Share of distinct words two strings have in common (0..1). */
export function tokenOverlap(a: string, b: string): number {
	const x = new Set(tokens(a).filter((word) => !COMPANY_SUFFIXES.has(word)));
	const y = new Set(tokens(b).filter((word) => !COMPANY_SUFFIXES.has(word)));
	if (x.size === 0 || y.size === 0) return 0;
	let shared = 0;
	for (const word of x) {
		if (y.has(word) || [...y].some((other) => other.length > 3 && word.length > 3 && (other.startsWith(word) || word.startsWith(other)))) {
			shared++;
		}
	}
	return shared / Math.min(x.size, y.size);
}

export function titleCase(value: string): string {
	return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? word : pluralWord}`;
}

/** "$1,250.00", "₦ 12 500", "(200)" and "1.2k" as numbers. */
export function parseLooseNumber(text: string): number | null {
	const raw = text.trim();
	if (!raw) return null;
	const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
	const suffix = raw.match(/([kmb])\s*\)?$/i)?.[1]?.toLowerCase();
	const digits = raw.replace(/[^0-9.]/g, '');
	if (!digits || !/\d/.test(digits) || digits.split('.').length > 2) return null;
	// Reject text that is mostly words, e.g. "Invoice 1042 for Acme".
	if (raw.replace(/[\d\s.,()$€£₦+\-kmb]/gi, '').length > 3) return null;
	let value = Number(digits);
	if (!Number.isFinite(value)) return null;
	if (suffix === 'k') value *= 1_000;
	if (suffix === 'm') value *= 1_000_000;
	if (suffix === 'b') value *= 1_000_000_000;
	return negative ? -value : value;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface LooseDate {
	iso: string;
	/** Day and month could be swapped, e.g. "03/04/25". */
	ambiguous: boolean;
}

function isoDate(year: number, month: number, day: number): string | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO, day-first or month-first numeric dates, and "3 Mar 2025" / "March 3, 2025". Day-first when unsure. */
export function parseLooseDate(text: string): LooseDate | null {
	const raw = text.trim().toLowerCase();
	if (!raw) return null;

	let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (match) {
		const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
		return iso ? { iso, ambiguous: false } : null;
	}

	match = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
	if (match) {
		const a = Number(match[1]);
		const b = Number(match[2]);
		const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
		if (a > 12) {
			const iso = isoDate(year, b, a);
			return iso ? { iso, ambiguous: false } : null;
		}
		if (b > 12) {
			const iso = isoDate(year, a, b);
			return iso ? { iso, ambiguous: false } : null;
		}
		const iso = isoDate(year, b, a);
		return iso ? { iso, ambiguous: a !== b } : null;
	}

	match = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})$/);
	if (match) {
		const month = MONTHS.indexOf(match[2].slice(0, 3)) + 1;
		const iso = month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
		return iso ? { iso, ambiguous: false } : null;
	}

	match = raw.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
	if (match) {
		const month = MONTHS.indexOf(match[1].slice(0, 3)) + 1;
		const iso = month ? isoDate(Number(match[3]), month, Number(match[2])) : null;
		return iso ? { iso, ambiguous: false } : null;
	}
	return null;
}

/** Columns whose name appears in the text, longest names first so "Unit Price" wins over "Price". */
export function mentionedColumns(text: string, columns: Column[]): Column[] {
	const haystack = ` ${normalizeText(text)} `;
	const found: Column[] = [];
	for (const column of [...columns].sort((a, b) => b.name.length - a.name.length)) {
		const needle = normalizeText(column.name);
		if (!needle) continue;
		const singular = needle.endsWith('s') ? needle.slice(0, -1) : needle;
		if (haystack.includes(` ${needle} `) || haystack.includes(` ${singular} `) || haystack.includes(` ${needle}s `)) {
			if (!found.some((other) => normalizeText(other.name).includes(needle))) found.push(column);
		}
	}
	return found;
}

/** "Qty" for "Quantity", "Amt" for "Amount": same first letter, the rest in order. */
export function isAbbreviation(short: string, long: string): boolean {
	const a = normalizeText(short).replace(/ /g, '');
	const b = normalizeText(long).replace(/ /g, '');
	if (a.length < 2 || a.length >= b.length || a[0] !== b[0]) return false;
	let index = 0;
	for (const char of b) if (char === a[index]) index++;
	return index === a.length;
}

/** Closest column by name, when it's close enough to be a likely typo or rename. */
export function closestColumn(name: string, columns: Column[], minimum = 0.6): Column | undefined {
	let best: Column | undefined;
	let bestScore = minimum;
	for (const column of columns) {
		const score = Math.max(similarity(name, column.name), tokenOverlap(name, column.name) * 0.9, isAbbreviation(name, column.name) ? 0.7 : 0);
		if (score > bestScore) {
			best = column;
			bestScore = score;
		}
	}
	return best;
}

/** Column names referenced as [Name] in a formula. */
export function referencedColumnNames(formula: string): string[] {
	return [...new Set([...formula.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]))];
}

/** Small deterministic hash, used to vary mock wording without randomness. */
export function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
