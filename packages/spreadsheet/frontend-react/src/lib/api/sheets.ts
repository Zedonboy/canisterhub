import type { Column, Sheet } from '@/lib/types';
import { apiGet } from './client';

/** Sheet as returned by the Rust API (storage metadata is added by the adapter). */
export type ApiSheet = Omit<Sheet, 'source' | 'writable'>;

export function fetchSheets(signal?: AbortSignal) {
	return apiGet<ApiSheet[]>('/api/sheets', undefined, signal);
}

export function fetchSheet(sheetId: string, signal?: AbortSignal) {
	return apiGet<ApiSheet>(`/api/sheets/${encodeURIComponent(sheetId)}`, undefined, signal);
}

export async function fetchColumns(sheetId: string, signal?: AbortSignal) {
	const columns = await apiGet<Column[]>(
		`/api/sheets/${encodeURIComponent(sheetId)}/columns`,
		undefined,
		signal
	);
	return columns.sort((a, b) => a.position - b.position);
}

export async function fetchHealth(signal?: AbortSignal) {
	return apiGet<{ status: string; database: string; mode: string }>(
		'/api/health',
		undefined,
		signal
	);
}
