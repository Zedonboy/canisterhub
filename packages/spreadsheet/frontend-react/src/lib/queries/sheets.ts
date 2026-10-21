import { queryOptions } from '@tanstack/react-query';
import { fetchHealth } from '@/lib/api/sheets';
import { sheetRepository } from '@/lib/storage';
import type { SheetSource } from '@/lib/types';
import { queryKeys } from './keys';

/** Lists only the given source's sheets, so picking "Local" never calls the API. */
export const sheetsQueryOptions = (source: SheetSource) =>
	queryOptions({
		queryKey: queryKeys.sheetList(source),
		queryFn: ({ signal }) => sheetRepository.listSheets(signal, [source])
	});

export const sheetQueryOptions = (sheetId: string) =>
	queryOptions({
		queryKey: queryKeys.sheetDetail(sheetId),
		queryFn: ({ signal }) => sheetRepository.getSheet(sheetId, signal)
	});

export const columnsQueryOptions = (sheetId: string) =>
	queryOptions({
		queryKey: queryKeys.columns(sheetId),
		queryFn: async ({ signal }) =>
			(await sheetRepository.listColumns(sheetId, signal)).sort((a, b) => a.position - b.position),
		staleTime: 5 * 60_000
	});

export const healthQueryOptions = () =>
	queryOptions({
		queryKey: queryKeys.health(),
		queryFn: ({ signal }) => fetchHealth(signal),
		staleTime: 15_000,
		retry: false
	});
