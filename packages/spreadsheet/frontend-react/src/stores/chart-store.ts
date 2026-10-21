import { create } from 'zustand';
import { newId } from '@/lib/utils/id';
import type { ChartDefinition } from '@/lib/charts/types';
import { patchItem, readCollection, watchCollectionStorage, writeCollection } from './local-collection';

/** Ported from lib/charts/chart-store.svelte.ts (see stores/local-collection.ts for the shared base logic). */

const STORAGE_KEY = 'silver:charts';

export type NewChartInput = Pick<ChartDefinition, 'name' | 'sheetId'> &
	Partial<Omit<ChartDefinition, 'id' | 'name' | 'sheetId' | 'createdAt' | 'updatedAt'>>;

interface ChartStoreState {
	/** Charts saved in this browser. */
	items: ChartDefinition[];
	get: (id: string) => ChartDefinition | null;
	create: (input: NewChartInput) => ChartDefinition;
	update: (id: string, patch: Partial<Omit<ChartDefinition, 'id' | 'createdAt'>>, touch?: boolean) => void;
	remove: (id: string) => void;
}

export const useChartStore = create<ChartStoreState>()((set, get) => {
	watchCollectionStorage(STORAGE_KEY, () => set({ items: readCollection(STORAGE_KEY) }));

	function save(items: ChartDefinition[]) {
		set({ items });
		writeCollection(STORAGE_KEY, items);
	}

	return {
		items: readCollection<ChartDefinition>(STORAGE_KEY),
		get: (id) => get().items.find((item) => item.id === id) ?? null,
		create: (input) => {
			const now = new Date().toISOString();
			const chart: ChartDefinition = {
				id: newId('chart'),
				description: '',
				type: 'bar',
				category: null,
				dateBucket: 'month',
				series: [{ id: newId('series'), column: null, fn: 'count' }],
				match: 'all',
				filters: [],
				sort: 'value-desc',
				limit: null,
				stacked: false,
				showValues: false,
				...input,
				name: input.name.trim() || 'Untitled chart',
				createdAt: now,
				updatedAt: now
			};
			save([chart, ...get().items]);
			return chart;
		},
		update: (id, patch, touch = true) => save(patchItem(get().items, id, patch, touch)),
		remove: (id) => save(get().items.filter((item) => item.id !== id))
	};
});

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const chartStore = {
	get items() {
		return useChartStore.getState().items;
	},
	get: (id: string) => useChartStore.getState().get(id),
	create: (input: NewChartInput) => useChartStore.getState().create(input),
	update: (id: string, patch: Partial<Omit<ChartDefinition, 'id' | 'createdAt'>>, touch?: boolean) =>
		useChartStore.getState().update(id, patch, touch),
	remove: (id: string) => useChartStore.getState().remove(id)
};
