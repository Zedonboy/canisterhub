import {
	fetchAggregate,
	fetchChildren,
	fetchRange,
	fetchRow,
	fetchRowPage,
	fetchRowsByIds
} from '@/lib/api/rows';
import { fetchColumns, fetchSheet, fetchSheets, type ApiSheet } from '@/lib/api/sheets';
import type { Sheet } from '@/lib/types';
import { ICP_SHEET_PREFIX, LOCAL_SHEET_PREFIX, StorageCapabilityError, type SheetStorageAdapter } from './types';

const withSource = (sheet: ApiSheet): Sheet => ({ ...sheet, source: 'server', writable: false });

const readOnly = () =>
	Promise.reject(new StorageCapabilityError('Server sheets are read-only in this version of IntelliSheet'));

/**
 * Adapter for sheets served by the Rust API (PostgreSQL). Reads only for now;
 * implementing the write methods here (plus API endpoints) is the path to
 * server-backed editing.
 */
export class HttpSheetAdapter implements SheetStorageAdapter {
	readonly source = 'server' as const;
	readonly capabilities = { createSheets: false, editCells: false, editRows: false };

	ownsSheet(sheetId: string) {
		return !sheetId.startsWith(LOCAL_SHEET_PREFIX) && !sheetId.startsWith(ICP_SHEET_PREFIX);
	}

	async listSheets(signal?: AbortSignal) {
		return (await fetchSheets(signal)).map(withSource);
	}

	async getSheet(sheetId: string, signal?: AbortSignal) {
		return withSource(await fetchSheet(sheetId, signal));
	}

	listColumns = fetchColumns;
	getRowPage = fetchRowPage;
	getRow = fetchRow;
	getChildren = fetchChildren;
	getRowsByIds = fetchRowsByIds;
	getRange = fetchRange;
	aggregate = fetchAggregate;

	createSheet = readOnly;
	deleteSheet = readOnly;
	updateColumn = readOnly;
	addColumn = readOnly;
	columnUsage = readOnly;
	deleteColumn = readOnly;
	updateCells = readOnly;
	insertRows = readOnly;
	deleteRows = readOnly;
	groupColumns = readOnly;
	ungroupColumns = readOnly;
	renameColumnGroup = readOnly;
	indentRows = readOnly;
	outdentRows = readOnly;
	undo = readOnly;
	redo = readOnly;

	historyState() {
		return { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
	}

	changeLog() {
		return [];
	}
	cacheFormulaValues = readOnly;
}
