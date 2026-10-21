/**
 * Ported from lib/stores/local-collection.svelte.ts. That file was a
 * `LocalCollection<T>` base class meant to be subclassed (`class FormStore
 * extends LocalCollection<FormDefinition>`), which doesn't translate
 * directly to Zustand (there's no "extend a store" primitive). Instead this
 * exports the localStorage read/write/cross-tab-resync logic as plain
 * functions; each concrete store (form-store.ts, chart-store.ts,
 * dashboard-store.ts) is its own small Zustand store built on top of them,
 * exposing the same `items`/`get`/`update`/`remove` shape the Svelte
 * version's base class gave its subclasses.
 */

export interface CollectionItem {
	id: string;
	createdAt: string;
	updatedAt: string;
}

export function readCollection<T extends CollectionItem>(storageKey: string): T[] {
	try {
		if (typeof localStorage === 'undefined') return [];
		const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

export function writeCollection<T extends CollectionItem>(storageKey: string, items: T[]): void {
	try {
		localStorage.setItem(storageKey, JSON.stringify(items));
	} catch {
		// Stays in memory for this session (storage full or disabled).
	}
}

/** Keeps other tabs' edits in sync; call the returned cleanup on unmount if ever needed (these stores are singletons, so it normally isn't). */
export function watchCollectionStorage(storageKey: string, onExternalChange: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const listener = (event: StorageEvent) => {
		if (event.key === storageKey) onExternalChange();
	};
	window.addEventListener('storage', listener);
	return () => window.removeEventListener('storage', listener);
}

/** Merges `patch` into an item; `touch` bumps `updatedAt` (off for bookkeeping such as counters). */
export function patchItem<T extends CollectionItem>(
	items: T[],
	id: string,
	patch: Partial<Omit<T, 'id' | 'createdAt'>>,
	touch = true
): T[] {
	const updatedAt = new Date().toISOString();
	return items.map((item) => (item.id === id ? { ...item, ...patch, ...(touch ? { updatedAt } : {}) } : item));
}
