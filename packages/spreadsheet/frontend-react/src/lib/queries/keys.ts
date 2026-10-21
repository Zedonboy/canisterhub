import type { SheetSource } from '@/lib/types';

/**
 * Query key factory. Everything for a sheet lives under ['sheets', sheetId] so
 * one invalidation refreshes metadata, row blocks and formula dependencies.
 */
export const queryKeys = {
	sheets: () => ['sheets'] as const,
	/** Pass a source to key the query itself; call with no args to invalidate every source's list at once. */
	sheetList: (source?: SheetSource) => (source ? (['sheets', 'list', source] as const) : (['sheets', 'list'] as const)),
	sheet: (sheetId: string) => ['sheets', sheetId] as const,
	sheetDetail: (sheetId: string) => ['sheets', sheetId, 'detail'] as const,
	columns: (sheetId: string) => ['sheets', sheetId, 'columns'] as const,
	columnUsage: (sheetId: string, columnKey: string) => ['sheets', sheetId, 'columns', 'usage', columnKey] as const,
	rowBlock: (sheetId: string, blockSize: number, block: number) =>
		['sheets', sheetId, 'rows', 'block', blockSize, block] as const,
	rowDetail: (sheetId: string, rowId: string) => ['sheets', sheetId, 'rows', 'detail', rowId] as const,
	children: (sheetId: string, rowId: string, columns: string[]) =>
		['sheets', sheetId, 'rows', 'children', rowId, columns.join(',')] as const,
	range: (sheetId: string, start: number, end: number, columns: string[]) =>
		['sheets', sheetId, 'range', start, end, columns.join(',')] as const,
	aggregate: (
		sheetId: string,
		operation: string,
		column: string,
		start?: number,
		end?: number,
		parentId?: string
	) => ['sheets', sheetId, 'aggregate', operation, column, start ?? null, end ?? null, parentId ?? null] as const,
	health: () => ['health'] as const
};
