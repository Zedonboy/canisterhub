import { defaultOptionColor } from '@/lib/grid/palette';
import type { EnumOption, OptionColor } from '@/lib/types';

/** Editable enum option in column forms (stable `id` for keyed lists). */
export interface OptionDraft {
	id: number;
	value: string;
	color: OptionColor;
}

let nextId = 0;

export function optionDraft(value = '', color: OptionColor = defaultOptionColor(0)): OptionDraft {
	return { id: nextId++, value, color };
}

export function optionDraftsFrom(options: EnumOption[]): OptionDraft[] {
	return options.map((option) => optionDraft(option.value, option.color));
}

export function draftsToOptions(drafts: OptionDraft[]): EnumOption[] {
	return drafts.map((draft) => ({ value: draft.value, color: draft.color }));
}

/** Starting options for a column switched to Enum: its existing values, or two blanks. */
export function suggestedOptionDrafts(values: string[]): OptionDraft[] {
	const drafts = values.slice(0, 50).map((value, index) => optionDraft(value, defaultOptionColor(index)));
	return drafts.length > 0 ? drafts : [optionDraft('', defaultOptionColor(0)), optionDraft('', defaultOptionColor(1))];
}
