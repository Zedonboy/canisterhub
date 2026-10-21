import { parseCellInput } from '@/lib/editing/cell-input';
import { formulaReferencesColumn } from '@/lib/editing/column-conversion';
import { defaultOptionColor, isOptionColor } from '@/lib/grid/palette';
import type { Column, ColumnSettings, EnumOption, KnownColumnType } from '@/lib/types';
import type { ColumnUpdateInput, CreateSheetInput, NewColumnInput, SheetValidationErrors } from './types';

export interface ColumnTypeChoice {
	value: KnownColumnType;
	label: string;
	hint: string;
}

/** Column types grouped as in the column forms: Glide cell kinds first, then IntelliSheet's custom types. */
export const COLUMN_TYPE_GROUPS: { label: string; types: ColumnTypeChoice[] }[] = [
	{
		label: 'Glide cells',
		types: [
			{ value: 'text', label: 'Text', hint: 'Text and formulas' },
			{ value: 'number', label: 'Number', hint: 'Quantities, scores' },
			{ value: 'boolean', label: 'Boolean', hint: 'Checkbox' },
			{ value: 'uri', label: 'URI', hint: 'Clickable links' },
			{ value: 'image', label: 'Image', hint: 'Image URLs' },
			{ value: 'markdown', label: 'Markdown', hint: 'Formatted notes' },
			{ value: 'bubble', label: 'Bubble', hint: 'Tags, multiple values' },
			{ value: 'drilldown', label: 'Drilldown', hint: 'Labels with images' },
			{ value: 'row-id', label: 'Row ID', hint: 'Identifiers' },
			{ value: 'protected', label: 'Protected', hint: 'Masked values' }
		]
	},
	{
		label: 'Custom cells',
		types: [
			{ value: 'currency', label: 'Currency', hint: 'Money amounts (USD)' },
			{ value: 'date', label: 'Date', hint: 'Calendar dates' },
			{ value: 'enum', label: 'Enum', hint: 'Fixed options with colours' }
		]
	}
];

export const CREATABLE_COLUMN_TYPES: ColumnTypeChoice[] = COLUMN_TYPE_GROUPS.flatMap((group) => group.types);

export const MAX_SHEET_NAME = 100;
export const MAX_DESCRIPTION = 500;
export const MAX_COLUMN_NAME = 60;
export const MAX_COLUMNS = 100;
export const MAX_ENUM_OPTIONS = 50;
export const MAX_GROUP_NAME = 60;

export function isCreatableType(type: string): type is KnownColumnType {
	return CREATABLE_COLUMN_TYPES.some((choice) => choice.value === type);
}

export function columnTypeLabel(type: string): string {
	return CREATABLE_COLUMN_TYPES.find((choice) => choice.value === type)?.label ?? type;
}

export type ValidationResult =
	| { ok: true; value: CreateSheetInput }
	| { ok: false; errors: SheetValidationErrors };

export type ColumnUpdateValidation = { ok: true; value: ColumnUpdateInput } | { ok: false; error: string };

/** Validates and normalises one column definition: name rules, type and enum options. */
export function validateColumnInput(input: NewColumnInput): { value: NewColumnInput; error?: string } {
	const name = input.name.trim();
	const settings: ColumnSettings = { ...input.settings };
	let error: string | undefined;
	const fail = (message: string) => (error ??= message);

	if (!name) fail('Column name is required');
	else if (name.length > MAX_COLUMN_NAME) fail(`Keep column names under ${MAX_COLUMN_NAME} characters`);
	else if (/[[\]]/.test(name)) fail('Column names cannot contain [ or ] (used by formulas)');

	if (!isCreatableType(input.data_type)) fail('Choose a column type');

	if (input.data_type === 'enum') {
		const options = normaliseOptions(settings.options ?? []);
		const values = new Set<string>();
		for (const option of options) {
			const key = option.value.toLowerCase();
			if (values.has(key)) fail(`Option "${option.value}" is listed twice`);
			values.add(key);
		}
		if (options.length === 0) fail('Add at least one option');
		else if (options.length > MAX_ENUM_OPTIONS) fail(`An enum can have at most ${MAX_ENUM_OPTIONS} options`);
		settings.options = options;
	} else {
		delete settings.options;
	}

	// Column formula: every cell in the column is calculated by it.
	if ('column_formula' in settings) {
		const formula = settings.column_formula?.trim() ?? '';
		if (!formula) settings.column_formula = undefined;
		else if (!formula.startsWith('=') || formula.length < 2) fail('Column formulas start with =, e.g. =[Quantity] * 2');
		else if (name && formulaReferencesColumn(formula, name)) {
			fail(`A column formula can't reference its own column [${name}]`);
		} else settings.column_formula = formula;
	}

	// Default value: parsed like typed input for the column's type.
	if (input.defaultInput !== undefined) {
		const text = input.defaultInput?.trim() ?? '';
		if (!text || settings.column_formula) {
			settings.default_value = undefined;
		} else {
			const column: Column = { id: '', key: '', name, data_type: input.data_type, position: 0, settings };
			const parsed = parseCellInput(column, text);
			if (parsed.ok) settings.default_value = parsed.value;
			else fail(`Default value: ${parsed.reason}`);
		}
	}

	return { value: { name, data_type: input.data_type, settings }, error };
}

/** Shared by the create dialog (inline errors) and adapters (authoritative check). */
export function validateCreateSheetInput(input: CreateSheetInput): ValidationResult {
	const errors: SheetValidationErrors = { columnErrors: {} };
	const name = input.name.trim();
	const description = input.description?.trim() || null;

	if (!name) errors.name = 'Give the sheet a name';
	else if (name.length > MAX_SHEET_NAME) errors.name = `Keep the name under ${MAX_SHEET_NAME} characters`;

	if (description && description.length > MAX_DESCRIPTION) {
		errors.description = `Keep the description under ${MAX_DESCRIPTION} characters`;
	}

	if (input.columns.length === 0) errors.columns = 'Add at least one column';
	else if (input.columns.length > MAX_COLUMNS) errors.columns = `A sheet can have at most ${MAX_COLUMNS} columns`;

	const seen = new Set<string>();
	const columns = input.columns.map((column, index) => {
		const { value, error } = validateColumnInput(column);
		const lower = value.name.toLowerCase();
		if (error) errors.columnErrors[index] = error;
		else if (seen.has(lower)) errors.columnErrors[index] = 'Column names must be unique';
		if (value.name) seen.add(lower);
		return value;
	});

	const hasErrors =
		errors.name || errors.description || errors.columns || Object.keys(errors.columnErrors).length > 0;
	return hasErrors ? { ok: false, errors } : { ok: true, value: { name, description, columns } };
}

/** Validates renaming / retyping `columnKey` against the sheet's other columns. */
export function validateColumnUpdate(
	columns: Column[],
	columnKey: string,
	input: ColumnUpdateInput
): ColumnUpdateValidation {
	const { value, error } = validateColumnInput(input);
	if (error) return { ok: false, error };

	const clash = findNameClash(columns, value.name, columnKey);
	if (clash) return { ok: false, error: `Another column is already named "${clash.name}"` };

	return { ok: true, value };
}

/** Validates a column being added to an existing sheet. */
export function validateNewColumn(
	columns: Column[],
	input: NewColumnInput
): { ok: true; value: NewColumnInput } | { ok: false; error: string } {
	if (columns.length >= MAX_COLUMNS) {
		return { ok: false, error: `A sheet can have at most ${MAX_COLUMNS} columns` };
	}
	const { value, error } = validateColumnInput(input);
	if (error) return { ok: false, error };

	const clash = findNameClash(columns, value.name);
	if (clash) return { ok: false, error: `A column named "${clash.name}" already exists` };

	return { ok: true, value };
}

function findNameClash(columns: Column[], name: string, exceptKey?: string): Column | undefined {
	const lower = name.trim().toLowerCase();
	return columns.find((column) => column.key !== exceptKey && column.name.trim().toLowerCase() === lower);
}

/** Validates and trims a column group name (used to create or rename a group). */
export function validateColumnGroupName(name: string): { value: string; error?: string } {
	const value = name.trim();
	if (!value) return { value, error: 'Give the group a name' };
	if (value.length > MAX_GROUP_NAME) return { value, error: `Keep group names under ${MAX_GROUP_NAME} characters` };
	return { value };
}

/** A `col_<slug>` key not used by any existing column. */
export function uniqueColumnKey(name: string, usedKeys: ReadonlySet<string>): string {
	const base = `col_${slug(name) || 'column'}`;
	let key = base;
	for (let n = 2; usedKeys.has(key); n++) key = `${base}_${n}`;
	return key;
}

/**
 * Settings after a column edit. Keeping the type keeps existing settings;
 * changing it resets type-specific settings (format, currency, colours…) but
 * keeps the column's layout.
 */
export function nextColumnSettings(current: Column, update: ColumnUpdateInput): ColumnSettings {
	const incoming = update.settings ?? {};
	if (update.data_type === current.data_type) return { ...current.settings, ...incoming };

	const settings: ColumnSettings = { ...incoming };
	if (current.settings.primary) settings.primary = true;
	if (current.settings.width !== undefined) settings.width = current.settings.width;
	if (update.data_type === 'currency') settings.currency ??= 'USD';
	return settings;
}

/** Trims values, drops blank rows and fills in missing colours. */
function normaliseOptions(options: EnumOption[]): EnumOption[] {
	return options
		.map((option) => ({ value: option.value.trim(), color: option.color }))
		.filter((option) => option.value !== '')
		.map((option, index) => ({
			value: option.value,
			color: isOptionColor(option.color) ? option.color : defaultOptionColor(index)
		}));
}

/** Turns validated column inputs into stored column definitions. */
export function buildColumns(inputs: NewColumnInput[], newId: () => string): Column[] {
	const usedKeys = new Set<string>();

	return inputs.map((input, index) => {
		const key = uniqueColumnKey(input.name, usedKeys);
		usedKeys.add(key);

		const settings: ColumnSettings = { ...input.settings };
		if (index === 0) {
			settings.primary = true;
			settings.width ??= 240;
		}
		if (input.data_type === 'currency') settings.currency ??= 'USD';

		return { id: newId(), key, name: input.name, data_type: input.data_type, position: index + 1, settings };
	});
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\w\s]/g, '')
		.trim()
		.replace(/\s+/g, '_')
		.slice(0, 40);
}

export function newId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
