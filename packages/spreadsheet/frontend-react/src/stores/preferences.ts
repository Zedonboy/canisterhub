import { create } from 'zustand';
import type { SheetSource } from '@/lib/types';

/**
 * Ported from lib/stores/preferences.svelte.ts. `rowHeight` is a derived
 * selector (see `rowHeightFor`/`useRowHeight`), not a stored field — same
 * reasoning as stores/theme.ts's `isDark`.
 */

export type GridDensity = 'compact' | 'comfortable' | 'spacious';

export const DENSITY_OPTIONS: { value: GridDensity; label: string; rowHeight: number }[] = [
	{ value: 'compact', label: 'Compact', rowHeight: 28 },
	{ value: 'comfortable', label: 'Comfortable', rowHeight: 34 },
	{ value: 'spacious', label: 'Spacious', rowHeight: 42 }
];

const DENSITY_KEY = 'silver:grid-density';
const SIDEBAR_KEY = 'silver:sidebar-collapsed';
const SHEET_SOURCE_KEY = 'silver:sheet-source';

function read(key: string): string | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Preference stays in memory (e.g. storage disabled).
	}
}

function readDensity(): GridDensity {
	const value = read(DENSITY_KEY);
	return DENSITY_OPTIONS.some((option) => option.value === value) ? (value as GridDensity) : 'comfortable';
}

function readSheetSource(): SheetSource {
	const value = read(SHEET_SOURCE_KEY);
	return value === 'server' || value === 'icp' ? value : 'local';
}

interface PreferencesState {
	density: GridDensity;
	sidebarCollapsed: boolean;
	/** Which sheets the Sheets list, Overview and pinned nav show: browser-local, or read-only from the API. */
	sheetSource: SheetSource;
	setDensity: (density: GridDensity) => void;
	toggleSidebar: () => void;
	setSheetSource: (source: SheetSource) => void;
}

export function rowHeightFor(density: GridDensity): number {
	return DENSITY_OPTIONS.find((option) => option.value === density)!.rowHeight;
}

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
	density: readDensity(),
	sidebarCollapsed: read(SIDEBAR_KEY) === 'true',
	sheetSource: readSheetSource(),
	setDensity: (density) => {
		set({ density });
		write(DENSITY_KEY, density);
	},
	toggleSidebar: () => {
		set({ sidebarCollapsed: !get().sidebarCollapsed });
		write(SIDEBAR_KEY, String(get().sidebarCollapsed));
	},
	setSheetSource: (source) => {
		set({ sheetSource: source });
		write(SHEET_SOURCE_KEY, source);
	}
}));

/** Convenience hook for components: `const rowHeight = useRowHeight();` */
export function useRowHeight(): number {
	return usePreferencesStore((state) => rowHeightFor(state.density));
}

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const preferences = {
	get density() {
		return usePreferencesStore.getState().density;
	},
	get sidebarCollapsed() {
		return usePreferencesStore.getState().sidebarCollapsed;
	},
	get sheetSource() {
		return usePreferencesStore.getState().sheetSource;
	},
	get rowHeight() {
		return rowHeightFor(usePreferencesStore.getState().density);
	},
	setDensity: (density: GridDensity) => usePreferencesStore.getState().setDensity(density),
	toggleSidebar: () => usePreferencesStore.getState().toggleSidebar(),
	setSheetSource: (source: SheetSource) => usePreferencesStore.getState().setSheetSource(source)
};
