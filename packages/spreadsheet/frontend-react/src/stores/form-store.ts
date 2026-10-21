import { create } from 'zustand';
import { newId } from '@/lib/utils/id';
import type { FormDefinition } from '@/lib/forms/types';
import { patchItem, readCollection, watchCollectionStorage, writeCollection } from './local-collection';

/** Ported from lib/forms/form-store.svelte.ts (see stores/local-collection.ts for the shared base logic). */

const STORAGE_KEY = 'silver:forms';

export type NewFormInput = Pick<FormDefinition, 'name' | 'sheetId' | 'fields'> & Partial<Pick<FormDefinition, 'description'>>;

interface FormStoreState {
	/** Forms saved in this browser. */
	items: FormDefinition[];
	get: (id: string) => FormDefinition | null;
	create: (input: NewFormInput) => FormDefinition;
	update: (id: string, patch: Partial<Omit<FormDefinition, 'id' | 'createdAt'>>, touch?: boolean) => void;
	remove: (id: string) => void;
	recordResponse: (id: string) => void;
}

export const useFormStore = create<FormStoreState>()((set, get) => {
	watchCollectionStorage(STORAGE_KEY, () => set({ items: readCollection(STORAGE_KEY) }));

	function save(items: FormDefinition[]) {
		set({ items });
		writeCollection(STORAGE_KEY, items);
	}

	return {
		items: readCollection<FormDefinition>(STORAGE_KEY),
		get: (id) => get().items.find((item) => item.id === id) ?? null,
		create: (input) => {
			const now = new Date().toISOString();
			const form: FormDefinition = {
				id: newId('form'),
				name: input.name.trim() || 'Untitled form',
				description: input.description?.trim() ?? '',
				sheetId: input.sheetId,
				fields: input.fields,
				layout: 'conversational',
				submitLabel: 'Submit',
				confirmation: 'Thanks! Your response was added.',
				allowAnother: true,
				responseCount: 0,
				lastResponseAt: null,
				createdAt: now,
				updatedAt: now
			};
			save([form, ...get().items]);
			return form;
		},
		update: (id, patch, touch = true) => save(patchItem(get().items, id, patch, touch)),
		remove: (id) => save(get().items.filter((item) => item.id !== id)),
		recordResponse: (id) => {
			const form = get().get(id);
			if (form) get().update(id, { responseCount: form.responseCount + 1, lastResponseAt: new Date().toISOString() }, false);
		}
	};
});

/** Non-reactive accessor for plain-TS modules, mirrors stores/theme.ts's `theme`. */
export const formStore = {
	get items() {
		return useFormStore.getState().items;
	},
	get: (id: string) => useFormStore.getState().get(id),
	create: (input: NewFormInput) => useFormStore.getState().create(input),
	update: (id: string, patch: Partial<Omit<FormDefinition, 'id' | 'createdAt'>>, touch?: boolean) =>
		useFormStore.getState().update(id, patch, touch),
	remove: (id: string) => useFormStore.getState().remove(id),
	recordResponse: (id: string) => useFormStore.getState().recordResponse(id)
};
