import { create } from 'zustand';

/** Ported from lib/stores/recent-sheets.svelte.ts. */

const STORAGE_KEY = 'silver:recent-sheets';
const MAX_ENTRIES = 12;

export interface RecentSheet {
	sheetId: string;
	openedAt: string;
}

function read(): RecentSheet[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		return Array.isArray(stored)
			? stored.filter((entry): entry is RecentSheet => typeof entry?.sheetId === 'string' && typeof entry?.openedAt === 'string')
			: [];
	} catch {
		return [];
	}
}

interface RecentSheetsState {
	/** Most recent first. Local preference, like favourites. */
	entries: RecentSheet[];
	record: (sheetId: string) => void;
	forget: (sheetId: string) => void;
}

function persist(set: (partial: Partial<RecentSheetsState>) => void, next: RecentSheet[]) {
	set({ entries: next });
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Storage may be unavailable (private mode); the list stays in memory.
	}
}

export const useRecentSheetsStore = create<RecentSheetsState>()((set, get) => ({
	entries: read(),
	record: (sheetId) => {
		const entry = { sheetId, openedAt: new Date().toISOString() };
		persist(set, [entry, ...get().entries.filter((existing) => existing.sheetId !== sheetId)].slice(0, MAX_ENTRIES));
	},
	forget: (sheetId) => {
		persist(
			set,
			get().entries.filter((entry) => entry.sheetId !== sheetId)
		);
	}
}));

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const recentSheets = {
	get entries() {
		return useRecentSheetsStore.getState().entries;
	},
	record: (sheetId: string) => useRecentSheetsStore.getState().record(sheetId),
	forget: (sheetId: string) => useRecentSheetsStore.getState().forget(sheetId)
};
