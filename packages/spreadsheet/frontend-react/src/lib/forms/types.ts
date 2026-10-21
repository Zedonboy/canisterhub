export interface FormField {
	id: string;
	/** The sheet column this field fills; keys don't change when a column is renamed. */
	columnKey: string;
	label: string;
	help: string;
	required: boolean;
	placeholder: string;
}

export type FormLayout = 'conversational' | 'classic';

/** A data entry form: each submission adds one row to its sheet. */
export interface FormDefinition {
	id: string;
	name: string;
	description: string;
	sheetId: string;
	fields: FormField[];
	/** Conversational: one question at a time, full screen, keyboard-driven — the default, and
	 *  the fill-it-out experience. Classic: every question on one page, better suited to a long,
	 *  fast internal data-entry form filled out many times in a row. */
	layout: FormLayout;
	submitLabel: string;
	/** Shown after a successful submission. */
	confirmation: string;
	/** Offer "Submit another response" after submitting. */
	allowAnother: boolean;
	responseCount: number;
	lastResponseAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Field values as entered, by field id. Checkboxes use "true"/"false". */
export type FormValues = Record<string, string>;
