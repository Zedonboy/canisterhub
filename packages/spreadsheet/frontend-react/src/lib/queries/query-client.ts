import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';

/** Errors that retrying cannot fix. */
function isPermanent(error: unknown): boolean {
	if (error instanceof ApiError) return error.isClientError;
	// Storage adapter errors (not found, validation, read-only, quota) are deterministic.
	return error instanceof Error && error.name.startsWith('Storage');
}

export function createAppQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => !isPermanent(error) && failureCount < 2
			}
		}
	});
}
