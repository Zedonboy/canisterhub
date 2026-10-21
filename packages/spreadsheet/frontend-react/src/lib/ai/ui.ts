import type { Severity } from './types';

export const SEVERITY_STYLES: Record<Severity, string> = {
	high: 'bg-red-50 text-red-700 ring-red-200',
	medium: 'bg-amber-50 text-amber-800 ring-amber-200',
	low: 'bg-zinc-100 text-zinc-600 ring-zinc-200'
};

export const SEVERITY_LABELS: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function timeLabel(iso: string): string {
	const date = new Date(iso);
	const sameDay = date.toDateString() === new Date().toDateString();
	return sameDay
		? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
		: date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
