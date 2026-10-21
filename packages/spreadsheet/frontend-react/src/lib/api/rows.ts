import type {
	AggregateRequest,
	AggregateResponse,
	RangeResult,
	RowData,
	RowDetail,
	RowPage,
	RowQueryParams,
	RowsByIdsResponse
} from '@/lib/types';
import { apiGet, apiPost } from './client';

const base = (sheetId: string) => `/api/sheets/${encodeURIComponent(sheetId)}`;
const columnList = (columns?: string[]) => (columns?.length ? columns.join(',') : undefined);

export function fetchRowPage(sheetId: string, params: RowQueryParams, signal?: AbortSignal) {
	return apiGet<RowPage>(
		`${base(sheetId)}/rows`,
		{
			offset: params.offset,
			limit: params.limit,
			sort: params.sort ? `${params.sort.column}:${params.sort.direction}` : undefined,
			filter: params.filter?.length ? JSON.stringify(params.filter) : undefined,
			columns: columnList(params.columns),
			search: params.search,
			include_total: params.includeTotal || undefined
		},
		signal
	);
}

export function fetchRow(sheetId: string, rowId: string, columns?: string[], signal?: AbortSignal) {
	return apiGet<RowDetail>(
		`${base(sheetId)}/rows/${encodeURIComponent(rowId)}`,
		{ columns: columnList(columns) },
		signal
	);
}

export function fetchChildren(
	sheetId: string,
	rowId: string,
	columns?: string[],
	signal?: AbortSignal
) {
	return apiGet<RowData[]>(
		`${base(sheetId)}/rows/${encodeURIComponent(rowId)}/children`,
		{ columns: columnList(columns) },
		signal
	);
}

export function fetchRowsByIds(
	sheetId: string,
	rowIds: string[],
	columns?: string[],
	signal?: AbortSignal
) {
	return apiPost<RowsByIdsResponse>(
		`${base(sheetId)}/rows/by-ids`,
		{ row_ids: rowIds, columns: columns?.length ? columns : undefined },
		signal
	);
}

export function fetchRange(
	sheetId: string,
	start: number,
	end: number,
	columns: string[],
	signal?: AbortSignal
) {
	return apiPost<RangeResult>(`${base(sheetId)}/range`, { columns, start, end }, signal);
}

export function fetchAggregate(request: AggregateRequest, signal?: AbortSignal) {
	return apiPost<AggregateResponse>(
		`${base(request.sheetId)}/aggregate`,
		{
			operation: request.operation,
			column: request.column,
			start: request.start,
			end: request.end,
			parent_id: request.parentId
		},
		signal
	);
}
