export const API_URL = (import.meta.env.PUBLIC_API_URL || 'http://localhost:8080').replace(/\/+$/, '');

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}

	get isClientError(): boolean {
		return this.status >= 400 && this.status < 500;
	}
}

type QueryValue = string | number | boolean | undefined | null;

async function request<T>(path: string, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${API_URL}${path}`, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		throw new ApiError(0, 'network', `Unable to reach the IntelliSheet API at ${API_URL}`);
	}

	if (!response.ok) {
		let code = 'http_error';
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = await response.json();
			code = body?.error?.code ?? code;
			message = body?.error?.message ?? message;
		} catch {
			// Non-JSON error bodies (e.g. extractor rejections) keep the status text.
		}
		throw new ApiError(response.status, code, message);
	}

	return (await response.json()) as T;
}

export function apiGet<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
	}
	const qs = params.toString();
	return request<T>(qs ? `${path}?${qs}` : path, {
		method: 'GET',
		headers: { Accept: 'application/json' },
		signal
	});
}

/** POST is used for read-only lookups whose parameters are naturally a body. */
export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal) {
	return request<T>(path, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
}
