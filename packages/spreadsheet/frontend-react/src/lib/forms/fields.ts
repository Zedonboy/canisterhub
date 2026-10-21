import { parseCellInput } from '@/lib/editing/cell-input';
import { newId } from '@/lib/reports/columns';
import { sheetRepository } from '@/lib/storage';
import type { CellValue, Column, RowDocument } from '@/lib/types';
import type { FormDefinition, FormField, FormValues } from './types';

/** Columns a form can fill: calculated (column formula) and generated id columns are left out. */
export function isFormColumn(column: Column): boolean {
	return !column.settings.column_formula && column.data_type !== 'row-id';
}

const PLACEHOLDERS: Partial<Record<string, string>> = {
	uri: 'https://example.com',
	image: 'https://example.com/photo.jpg',
	bubble: 'Separate values with commas',
	drilldown: 'Label | image URL, separated by commas',
	number: '0',
	currency: '0.00'
};

/** The HTML input type for a column, shared by both renderers. */
export function inputType(column: Column): string {
	switch (column.data_type) {
		case 'number':
		case 'currency':
			return 'number';
		case 'date':
			return 'date';
		case 'uri':
			return 'url';
		case 'protected':
			return 'password';
		default:
			return 'text';
	}
}

export function fieldFor(column: Column): FormField {
	return {
		id: newId('field'),
		columnKey: column.key,
		label: column.name,
		help: '',
		required: !!column.settings.primary,
		placeholder: PLACEHOLDERS[column.data_type] ?? ''
	};
}

export function defaultFields(columns: Column[]): FormField[] {
	return [...columns].sort((a, b) => a.position - b.position).filter(isFormColumn).map(fieldFor);
}

export type SubmissionCheck = { ok: true; data: RowDocument } | { ok: false; errors: Record<string, string> };
export type FieldCheck = { ok: true; value: CellValue | undefined } | { ok: false; reason: string };

/**
 * Validates one answer against its column's type. `value: undefined` means the field is blank
 * and not required — leave the cell unset, as opposed to a value to actually store (including
 * `false` and `0`, which are valid answers, not blanks). Shared by the all-at-once and
 * one-question-at-a-time renderers so a question is checked the same way in both.
 */
export function checkField(column: Column, field: FormField, rawText: string): FieldCheck {
	const text = rawText.trim();

	if (column.data_type === 'boolean') {
		if (field.required && text !== 'true') return { ok: false, reason: 'Tick this box to continue.' };
		return { ok: true, value: text === 'true' ? true : undefined };
	}
	if (!text) return field.required ? { ok: false, reason: 'This field is required.' } : { ok: true, value: undefined };

	const numeric = column.data_type === 'number' || column.data_type === 'currency';
	// Answers are data, never formulas: text starting with "=" is stored as typed.
	if (text.startsWith('=') && !numeric) return { ok: true, value: text };

	const parsed = parseCellInput(column, text);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	if (numeric && typeof parsed.value !== 'number') return { ok: false, reason: 'Enter a number.' };
	if (column.data_type === 'date' && !(typeof parsed.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.value)))
		return { ok: false, reason: 'Enter a date.' };
	return { ok: true, value: parsed.value };
}

/** Validates every field and builds the new row. */
export function checkSubmission(form: FormDefinition, columns: Column[], values: FormValues): SubmissionCheck {
	const data: RowDocument = {};
	const errors: Record<string, string> = {};

	for (const field of form.fields) {
		const column = columns.find((candidate) => candidate.key === field.columnKey);
		if (!column || !isFormColumn(column)) continue;
		const result = checkField(column, field, values[field.id] ?? '');
		if (!result.ok) errors[field.id] = result.reason;
		else if (result.value !== undefined) data[column.key] = result.value;
	}

	return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}

/** Adds the row to the end of the sheet as one undoable change. */
export async function submitResponse(form: FormDefinition, data: RowDocument) {
	const [row] = await sheetRepository.insertRows(form.sheetId, { count: 1, rows: [data], label: `Form: ${form.name}` });
	return row;
}
