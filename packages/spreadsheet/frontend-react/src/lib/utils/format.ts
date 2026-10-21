const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
	const key = JSON.stringify(options);
	let formatter = numberFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat(undefined, options);
		numberFormatters.set(key, formatter);
	}
	return formatter;
}

export interface NumberDisplayOptions {
	decimals?: number;
	prefix?: string;
	suffix?: string;
}

export function formatNumber(value: number, options: NumberDisplayOptions = {}): string {
	const decimals = options.decimals;
	const formatted = numberFormatter(
		decimals === undefined
			? { maximumFractionDigits: 2 }
			: { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
	).format(value);
	return `${options.prefix ?? ''}${formatted}${options.suffix ?? ''}`;
}

export function formatCurrency(value: number, currency = 'USD', decimals = 2): string {
	return numberFormatter({
		style: 'currency',
		currency,
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	}).format(value);
}

export function formatPercent(value: number, decimals = 1): string {
	return numberFormatter({
		style: 'percent',
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	}).format(value);
}

export function formatCount(value: number): string {
	return numberFormatter({ maximumFractionDigits: 0 }).format(value);
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC'
});

/** Formats `YYYY-MM-DD` (or ISO timestamps) without local-timezone day shifts. */
export function formatDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	const date = match
		? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
		: new Date(value);
	return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 3600],
	['month', 30 * 24 * 3600],
	['week', 7 * 24 * 3600],
	['day', 24 * 3600],
	['hour', 3600],
	['minute', 60]
];

export function formatRelativeTime(iso: string, now = Date.now()): string {
	const seconds = (new Date(iso).getTime() - now) / 1000;
	for (const [unit, size] of RELATIVE_UNITS) {
		if (Math.abs(seconds) >= size) return relativeFormatter.format(Math.round(seconds / size), unit);
	}
	return 'just now';
}
