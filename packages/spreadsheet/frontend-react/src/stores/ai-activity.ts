import { create } from 'zustand';
import { AI_FEATURE_COST, AI_FEATURE_LABELS, type AiFeature } from '@/lib/ai/activity-types';

/** Ported from lib/ai/activity.svelte.ts. */

/** Mock credits available per calendar month, per browser. */
export const AI_MONTHLY_CREDITS = 300;

const STORAGE_KEY = 'silver:ai:activity';
const MAX_ENTRIES = 300;

export interface AiActivityEntry {
	id: string;
	at: string;
	feature: AiFeature;
	sheetName: string | null;
	credits: number;
	status: 'ok' | 'failed' | 'blocked';
	summary: string;
}

export class AiLimitError extends Error {
	constructor() {
		super(`This month’s ${AI_MONTHLY_CREDITS} AI credits are used up. Reset the counter in the Activity tab to keep testing.`);
		this.name = 'AiLimitError';
	}
}

function load(): AiActivityEntry[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function monthKey(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth()}`;
}

/** Derived selector: credits used so far this calendar month. */
export function usedThisMonth(entries: AiActivityEntry[]): number {
	const current = monthKey(new Date());
	return entries
		.filter((entry) => entry.status === 'ok' && monthKey(new Date(entry.at)) === current)
		.reduce((sum, entry) => sum + entry.credits, 0);
}

/** Derived selector: credits left this calendar month. */
export function remainingCredits(entries: AiActivityEntry[]): number {
	return Math.max(0, AI_MONTHLY_CREDITS - usedThisMonth(entries));
}

interface AiActivityState {
	/** Every AI request, with who-asked-what context and credit use, kept in this browser. */
	entries: AiActivityEntry[];
	/**
	 * Runs one AI request: checks the monthly limit, then records the outcome.
	 * `describe` turns the result into a one-line log summary.
	 */
	run: <T>(feature: AiFeature, sheetName: string | null, work: () => Promise<T>, describe: (result: T) => string) => Promise<T>;
	reset: () => void;
	label: (feature: AiFeature) => string;
}

export const useAiActivityStore = create<AiActivityState>()((set, get) => {
	function addEntry(entry: Omit<AiActivityEntry, 'id' | 'at'>) {
		const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
		const entries = [{ ...entry, id, at: new Date().toISOString() }, ...get().entries].slice(0, MAX_ENTRIES);
		set({ entries });
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
		} catch {
			// The log stays in memory if storage is unavailable.
		}
	}

	return {
		entries: load(),
		run: async (feature, sheetName, work, describe) => {
			const credits = AI_FEATURE_COST[feature];
			if (credits > remainingCredits(get().entries)) {
				addEntry({ feature, sheetName, credits: 0, status: 'blocked', summary: 'Monthly limit reached' });
				throw new AiLimitError();
			}
			try {
				const result = await work();
				addEntry({ feature, sheetName, credits, status: 'ok', summary: describe(result) });
				return result;
			} catch (error) {
				addEntry({ feature, sheetName, credits: 0, status: 'failed', summary: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},
		reset: () => {
			set({ entries: [] });
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
			} catch {
				// The log stays in memory if storage is unavailable.
			}
		},
		label: (feature) => AI_FEATURE_LABELS[feature]
	};
});
