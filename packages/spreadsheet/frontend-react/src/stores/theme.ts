import { create } from 'zustand';

/**
 * Ported from the SvelteKit app's src/lib/stores/theme.svelte.ts (a runes
 * class singleton) as a Zustand store — see the migration plan's Phase 2
 * (state layer). Pulled forward into Phase 1 because storage/sheet-schema.ts
 * transitively depends on it via lib/grid/palette.ts's `theme.dark` read;
 * every other Phase 2 singleton is converted on its own schedule.
 *
 * `dark` is deliberately NOT a stored field: Zustand's `set()` merges via
 * `{ ...state, ...partial }`, which would freeze a getter property into a
 * stale snapshot the first time any other field changes. Compute it from
 * `mode`/`systemDark` instead, via the `isDark()` selector below.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' },
	{ value: 'system', label: 'System' }
];

// Also read by the inline script in index.html, which applies the theme before first paint.
const THEME_KEY = 'silver:theme';

function readMode(): ThemeMode {
	try {
		const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(THEME_KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

function readSystemDark(): boolean {
	return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

interface ThemeState {
	mode: ThemeMode;
	systemDark: boolean;
	setMode: (mode: ThemeMode) => void;
	/** Light -> dark -> system, for the compact sidebar button. */
	cycle: () => void;
	/** Mirrors the resolved theme onto <html> (Tailwind's `dark` class and native form colours). */
	apply: () => void;
}

/** Whether the resolved theme is dark (mode === 'dark', or 'system' + OS prefers dark). */
export function isDark(state: Pick<ThemeState, 'mode' | 'systemDark'>): boolean {
	return state.mode === 'dark' || (state.mode === 'system' && state.systemDark);
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
	mode: readMode(),
	systemDark: readSystemDark(),
	setMode: (mode) => {
		set({ mode });
		try {
			localStorage.setItem(THEME_KEY, mode);
		} catch {
			// Theme stays in memory (e.g. storage disabled).
		}
	},
	cycle: () => {
		const index = THEME_OPTIONS.findIndex((option) => option.value === get().mode);
		get().setMode(THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length].value);
	},
	apply: () => {
		const dark = isDark(get());
		const root = document.documentElement;
		root.classList.toggle('dark', dark);
		root.style.colorScheme = dark ? 'dark' : 'light';
	}
}));

/** Convenience hook for components: `const dark = useIsDark();` */
export function useIsDark(): boolean {
	return useThemeStore(isDark);
}

if (typeof window !== 'undefined' && window.matchMedia) {
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
		useThemeStore.setState({ systemDark: event.matches });
	});
}

/**
 * Non-reactive accessor for plain-TS modules that just need the current
 * value once (e.g. lib/grid/palette.ts) and aren't React components, so
 * can't use the `useThemeStore`/`useIsDark` hooks.
 */
export const theme = {
	get dark() {
		return isDark(useThemeStore.getState());
	}
};
