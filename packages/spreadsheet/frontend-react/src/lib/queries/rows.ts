import { queryOptions } from '@tanstack/react-query';
import { sheetRepository } from '@/lib/storage';
import type { AggregateRequest } from '@/lib/types';
import { queryKeys } from './keys';

/** Rows per windowed fetch. */
export const ROW_BLOCK_SIZE = 200;

/**
 * Row blocks are consumed imperatively by the row store (via
 * `queryClient.fetchQuery`) rather than through component observers, so they
 * get a short gcTime: blocks scrolled far away don't linger in memory.
 */
export const rowBlockQueryOptions = (sheetId: string, block: number, blockSize = ROW_BLOCK_SIZE) =>
	queryOptions({
		queryKey: queryKeys.rowBlock(sheetId, blockSize, block),
		queryFn: ({ signal }) =>
			sheetRepository.getRowPage(sheetId, { offset: block * blockSize, limit: blockSize }, signal),
		staleTime: 60_000,
		gcTime: 60_000
	});

export const rowDetailQueryOptions = (sheetId: string, rowId: string) =>
	queryOptions({
		queryKey: queryKeys.rowDetail(sheetId, rowId),
		queryFn: ({ signal }) => sheetRepository.getRow(sheetId, rowId, [], signal),
		staleTime: 60_000
	});

export const childrenQueryOptions = (sheetId: string, rowId: string, columns: string[]) =>
	queryOptions({
		queryKey: queryKeys.children(sheetId, rowId, columns),
		queryFn: ({ signal }) => sheetRepository.getChildren(sheetId, rowId, columns, signal),
		staleTime: 60_000
	});

export const rangeQueryOptions = (sheetId: string, start: number, end: number, columns: string[]) =>
	queryOptions({
		queryKey: queryKeys.range(sheetId, start, end, columns),
		queryFn: ({ signal }) => sheetRepository.getRange(sheetId, start, end, columns, signal),
		staleTime: 60_000
	});

export const aggregateQueryOptions = (request: AggregateRequest) =>
	queryOptions({
		queryKey: queryKeys.aggregate(
			request.sheetId,
			request.operation,
			request.column,
			request.start,
			request.end,
			request.parentId
		),
		queryFn: ({ signal }) => sheetRepository.aggregate(request, signal),
		staleTime: 60_000
	});
