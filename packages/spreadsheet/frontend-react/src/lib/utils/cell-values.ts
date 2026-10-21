import type { CellValue, DrilldownItem } from '@/lib/types';
import { isFormulaCell } from '@/lib/types';

/** Splits list input ("a, b" or one per line), trimming and de-duplicating. */
export function splitList(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,\n]/)
				.map((part) => part.trim())
				.filter(Boolean)
		)
	];
}

/** String entries of a multi-value cell (bubble tags, image URLs). */
export function toStringList(value: CellValue | undefined): string[] {
	if (value === undefined || value === null || isFormulaCell(value)) return [];
	if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : item.text));
	if (typeof value === 'string') return splitList(value);
	return [String(value)];
}

export function toDrilldownItems(value: CellValue | undefined): DrilldownItem[] {
	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === 'string' ? { text: item } : item));
	}
	return toStringList(value).map((text) => ({ text }));
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns an href that is safe to open, or null. Bare domains get https://;
 * anything else (javascript:, data:, relative paths) is refused.
 */
export function safeHref(uri: string): string | null {
	const text = uri.trim();
	if (!text) return null;
	try {
		const url = new URL(text);
		return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
	} catch {
		return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) ? `https://${text}` : null;
	}
}

/** Image sources the grid may load: http(s) URLs and inline data:image URIs. */
export function isSafeImageUrl(src: string): boolean {
	const text = src.trim();
	if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(text)) return true;
	try {
		const url = new URL(text);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
