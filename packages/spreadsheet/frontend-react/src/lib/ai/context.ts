import { PROTECTED_MASK } from '@/lib/grid/cell-text';
import { sheetRepository } from '@/lib/storage';
import { isEmptyCellValue, type Column, type RowData, type RowPage, type Sheet } from '@/lib/types';
import type { ContextRow, SheetContext, SheetTools } from './types';

const PAGE = 500;

/** Replaces Protected column values so they never reach an AI provider. */
export function maskRow(row: RowData, columns: Column[]): ContextRow {
	const data = { ...row.data };
	for (const column of columns) {
		if (column.data_type === 'protected' && !isEmptyCellValue(data[column.key])) data[column.key] = PROTECTED_MASK;
	}
	return { id: row.id, parent_id: row.parent_id, position: row.position, depth: row.depth, has_children: row.has_children, data };
}

/** Reads up to `limit` rows in display order, masked. */
export async function readRows(sheetId: string, columns: Column[], limit: number): Promise<ContextRow[]> {
	const rows: ContextRow[] = [];
	for (let offset = 0; offset < limit; offset += PAGE) {
		const page = await sheetRepository.getRowPage(sheetId, { offset, limit: Math.min(PAGE, limit - offset) });
		rows.push(...page.rows.map((row) => maskRow(row, columns)));
		if (page.rows.length < Math.min(PAGE, limit - offset)) break;
	}
	return rows;
}

/** Schema plus a masked sample of rows: what an AI request is allowed to see. */
export async function buildSheetContext(sheet: Sheet, columns: Column[], sampleSize = 2_000): Promise<SheetContext> {
	const rows = await readRows(sheet.id, columns, Math.min(sampleSize, Math.max(sheet.row_count, 1)));
	return {
		sheetId: sheet.id,
		name: sheet.name,
		description: sheet.description,
		source: sheet.source,
		writable: sheet.writable,
		rowCount: sheet.row_count,
		columns,
		rows,
		sampled: sheet.row_count > rows.length
	};
}

/** Read-only tools for questions: filtered row pages and aggregates, never Protected values. */
export function sheetTools(sheetId: string, columns: Column[]): SheetTools {
	const isProtected = (key: string) => columns.some((column) => column.key === key && column.data_type === 'protected');
	return {
		async queryRows(params): Promise<RowPage> {
			if (params.filter?.some((filter) => isProtected(filter.column))) throw new Error('Protected columns can’t be queried by AI.');
			const page = await sheetRepository.getRowPage(sheetId, params);
			return { ...page, rows: page.rows.map((row) => ({ ...row, ...maskRow(row, columns) })) };
		},
		async aggregate(operation, columnKey, parentId) {
			if (isProtected(columnKey)) throw new Error('Protected columns can’t be summarised by AI.');
			return sheetRepository.aggregate({ sheetId, operation, column: columnKey, parentId });
		}
	};
}
