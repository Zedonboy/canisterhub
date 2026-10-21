import { create } from 'zustand';

/**
 * Ported from lib/stores/favorites.svelte.ts. `SvelteSet` (a reactive Set
 * with no React equivalent) becomes a plain `Set<string>` held in Zustand
 * state — replaced wholesale on every mutation (Zustand needs a new
 * reference to notify subscribers; mutating a Set in place wouldn't).
 *
 * Favourite sheets are a local, per-browser preference. They never write to
 * the backend, keeping the MVP strictly read-only.
 */

const STORAGE_KEY = 'silver:favorite-sheets';

function readIds(): Set<string> {
	if (typeof localStorage === 'undefined') return new Set();
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		return Array.isArray(stored) ? new Set(stored.filter((id): id is string => typeof id === 'string')) : new Set();
	} catch {
		return new Set();
	}
}

function persist(ids: Set<string>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// Storage may be unavailable (private mode); favourites stay in memory.
	}
}

interface FavoritesState {
	ids: Set<string>;
	has: (sheetId: string) => boolean;
	toggle: (sheetId: string) => void;
}

export const useFavoritesStore = create<FavoritesState>()((set, get) => ({
	ids: readIds(),
	has: (sheetId) => get().ids.has(sheetId),
	toggle: (sheetId) => {
		const ids = new Set(get().ids);
		if (ids.has(sheetId)) ids.delete(sheetId);
		else ids.add(sheetId);
		set({ ids });
		persist(ids);
	}
}));

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const favorites = {
	get ids() {
		return useFavoritesStore.getState().ids;
	},
	has: (sheetId: string) => useFavoritesStore.getState().has(sheetId),
	toggle: (sheetId: string) => useFavoritesStore.getState().toggle(sheetId)
};
