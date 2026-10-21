import { create } from 'zustand';
import { newId } from '@/lib/utils/id';
import type { DashboardDefinition, DashboardWidget } from '@/lib/dashboards/types';
import { patchItem, readCollection, watchCollectionStorage, writeCollection } from './local-collection';

/** Ported from lib/dashboards/dashboard-store.svelte.ts (see stores/local-collection.ts for the shared base logic). */

const STORAGE_KEY = 'silver:dashboards';

export type NewDashboardInput = Pick<DashboardDefinition, 'name'> & Partial<Pick<DashboardDefinition, 'description' | 'widgets'>>;
export type DashboardPatch = Partial<Omit<DashboardDefinition, 'id' | 'createdAt' | 'updatedAt'>>;

interface DashboardStoreState {
	/** Dashboards saved in this browser. */
	items: DashboardDefinition[];
	get: (id: string) => DashboardDefinition | null;
	create: (input: NewDashboardInput) => DashboardDefinition;
	update: (id: string, patch: DashboardPatch, touch?: boolean) => void;
	remove: (id: string) => void;
	addWidget: (dashboardId: string, widget: DashboardWidget) => void;
	updateWidget: (dashboardId: string, widgetId: string, patch: Partial<DashboardWidget>) => void;
	removeWidget: (dashboardId: string, widgetId: string) => void;
	moveWidget: (dashboardId: string, index: number, by: number) => void;
}

export const useDashboardStore = create<DashboardStoreState>()((set, get) => {
	watchCollectionStorage(STORAGE_KEY, () => set({ items: readCollection(STORAGE_KEY) }));

	function save(items: DashboardDefinition[]) {
		set({ items });
		writeCollection(STORAGE_KEY, items);
	}

	return {
		items: readCollection<DashboardDefinition>(STORAGE_KEY),
		get: (id) => get().items.find((item) => item.id === id) ?? null,
		create: (input) => {
			const now = new Date().toISOString();
			const dashboard: DashboardDefinition = {
				id: newId('dashboard'),
				name: input.name.trim() || 'Untitled dashboard',
				description: input.description?.trim() ?? '',
				widgets: input.widgets ?? [],
				createdAt: now,
				updatedAt: now
			};
			save([dashboard, ...get().items]);
			return dashboard;
		},
		update: (id, patch, touch = true) => save(patchItem(get().items, id, patch, touch)),
		remove: (id) => save(get().items.filter((item) => item.id !== id)),
		addWidget: (dashboardId, widget) => {
			const dashboard = get().get(dashboardId);
			if (dashboard) get().update(dashboardId, { widgets: [...dashboard.widgets, widget] });
		},
		updateWidget: (dashboardId, widgetId, patch) => {
			const dashboard = get().get(dashboardId);
			if (!dashboard) return;
			get().update(dashboardId, {
				widgets: dashboard.widgets.map((widget) => (widget.id === widgetId ? ({ ...widget, ...patch } as DashboardWidget) : widget))
			});
		},
		removeWidget: (dashboardId, widgetId) => {
			const dashboard = get().get(dashboardId);
			if (dashboard) get().update(dashboardId, { widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId) });
		},
		moveWidget: (dashboardId, index, by) => {
			const dashboard = get().get(dashboardId);
			if (!dashboard) return;
			const widgets = [...dashboard.widgets];
			const target = index + by;
			if (target < 0 || target >= widgets.length) return;
			const [widget] = widgets.splice(index, 1);
			widgets.splice(target, 0, widget);
			get().update(dashboardId, { widgets });
		}
	};
});

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const dashboardStore = {
	get items() {
		return useDashboardStore.getState().items;
	},
	get: (id: string) => useDashboardStore.getState().get(id),
	create: (input: NewDashboardInput) => useDashboardStore.getState().create(input),
	update: (id: string, patch: DashboardPatch, touch?: boolean) => useDashboardStore.getState().update(id, patch, touch),
	remove: (id: string) => useDashboardStore.getState().remove(id),
	addWidget: (dashboardId: string, widget: DashboardWidget) => useDashboardStore.getState().addWidget(dashboardId, widget),
	updateWidget: (dashboardId: string, widgetId: string, patch: Partial<DashboardWidget>) =>
		useDashboardStore.getState().updateWidget(dashboardId, widgetId, patch),
	removeWidget: (dashboardId: string, widgetId: string) => useDashboardStore.getState().removeWidget(dashboardId, widgetId),
	moveWidget: (dashboardId: string, index: number, by: number) => useDashboardStore.getState().moveWidget(dashboardId, index, by)
};
