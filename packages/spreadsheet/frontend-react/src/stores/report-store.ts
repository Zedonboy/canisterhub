import { create } from 'zustand';
import { newId } from '@/lib/utils/id';
import type { ReportDefinition } from '@/lib/reports/types';
import { watchCollectionStorage } from './local-collection';

/**
 * Ported from lib/reports/report-store.svelte.ts. Hand-rolled in the
 * Svelte app (predates `LocalCollection`) rather than extending it, so it's
 * ported the same way here rather than routed through stores/local-collection.ts.
 */

const REPORTS_KEY = 'silver:reports';

function readReports(): ReportDefinition[] {
	try {
		const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(REPORTS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? (parsed as ReportDefinition[]) : [];
	} catch {
		return [];
	}
}

export type NewReportInput = Pick<ReportDefinition, 'name' | 'sources'> &
	Partial<Pick<ReportDefinition, 'description' | 'columns' | 'match' | 'filters' | 'groupBy' | 'ageBuckets' | 'summaries' | 'sort'>>;

export type ReportPatch = Partial<Omit<ReportDefinition, 'id' | 'createdAt' | 'updatedAt'>>;

interface ReportStoreState {
	/** Report definitions saved in this browser. Reports store queries, never copies of rows. */
	reports: ReportDefinition[];
	get: (id: string) => ReportDefinition | null;
	create: (input: NewReportInput) => ReportDefinition;
	update: (id: string, patch: ReportPatch) => void;
	remove: (id: string) => void;
}

export const useReportStore = create<ReportStoreState>()((set, get) => {
	watchCollectionStorage(REPORTS_KEY, () => set({ reports: readReports() }));

	function save(next: ReportDefinition[]) {
		set({ reports: next });
		try {
			localStorage.setItem(REPORTS_KEY, JSON.stringify(next));
		} catch {
			// Stays in memory for this session (e.g. storage full or disabled).
		}
	}

	return {
		reports: readReports(),
		get: (id) => get().reports.find((report) => report.id === id) ?? null,
		create: (input) => {
			const now = new Date().toISOString();
			const report: ReportDefinition = {
				id: newId('report'),
				name: input.name.trim(),
				description: input.description?.trim() ?? '',
				sources: input.sources,
				columns: input.columns ?? [],
				match: input.match ?? 'all',
				filters: input.filters ?? [],
				groupBy: input.groupBy ?? null,
				ageBuckets: input.ageBuckets ?? null,
				summaries: input.summaries ?? [],
				sort: input.sort ?? null,
				createdAt: now,
				updatedAt: now
			};
			save([report, ...get().reports]);
			return report;
		},
		update: (id, patch) => {
			save(get().reports.map((report) => (report.id === id ? { ...report, ...patch, updatedAt: new Date().toISOString() } : report)));
		},
		remove: (id) => save(get().reports.filter((report) => report.id !== id))
	};
});

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const reportStore = {
	get reports() {
		return useReportStore.getState().reports;
	},
	get: (id: string) => useReportStore.getState().get(id),
	create: (input: NewReportInput) => useReportStore.getState().create(input),
	update: (id: string, patch: ReportPatch) => useReportStore.getState().update(id, patch),
	remove: (id: string) => useReportStore.getState().remove(id)
};
