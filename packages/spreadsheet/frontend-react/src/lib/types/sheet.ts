/**
 * Column types mirroring Glide Data Grid's cell kinds
 * (https://docs.grid.glideapps.com/api/cells). Loading is a render state, not
 * a data type, so it has no column type.
 */
import type { CellValue } from './row';

export type GlideColumnType =
	| 'text'
	| 'number'
	| 'boolean'
	| 'uri'
	| 'image'
	| 'markdown'
	| 'bubble'
	| 'drilldown'
	| 'row-id'
	| 'protected';

/** IntelliSheet column types rendered with Glide custom cells or formatted native cells. */
export type CustomColumnType = 'currency' | 'date' | 'enum' | 'user';

/**
 * Column types known to the app. The union stays open (`string & {}`) so new
 * backend types degrade to text rendering instead of breaking the grid.
 *
 * There is no formula column type: any cell whose input starts with "=" is a
 * formula, and formulas normally live in text columns.
 */
export type KnownColumnType = GlideColumnType | CustomColumnType;

export type ColumnDataType = KnownColumnType | (string & {});

/** Colour names understood by the grid renderers (see grid/palette.ts). */
export const OPTION_COLORS = ['slate', 'blue', 'green', 'red', 'amber', 'orange', 'violet', 'teal', 'pink'] as const;

export type OptionColor = (typeof OPTION_COLORS)[number];

/** One allowed value of an enum column. */
export interface EnumOption {
	value: string;
	color: OptionColor;
}

export interface UserDirectoryEntry {
	name: string;
	email?: string;
}

/** How a text column displays formula results. */
export type ValueFormat = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean';

export interface ColumnSettings {
	primary?: boolean;
	width?: number;
	/** Enum columns: the allowed values and their colours. */
	options?: EnumOption[];
	/** Text columns: value -> colour, so matching results (e.g. from a formula) render as pills. */
	colors?: Record<string, string>;
	users?: Record<string, UserDirectoryEntry>;
	currency?: string;
	decimals?: number;
	prefix?: string;
	suffix?: string;
	/** Text columns: display format for formula results (automatic when omitted). */
	format?: ValueFormat;
	/** Value (or per-row formula) filled into new rows. */
	default_value?: CellValue;
	/** Column formula: every cell is calculated by this formula and can't be edited individually. */
	column_formula?: string;
	/** Name of the column group this column belongs to (shown as a header spanning its columns). */
	column_group?: string;
	[key: string]: unknown;
}

export interface Column {
	id: string;
	/** Property name inside `RowData.data`. */
	key: string;
	name: string;
	data_type: ColumnDataType;
	position: number;
	settings: ColumnSettings;
}

/** Which storage adapter owns a sheet. */
export type SheetSource = 'server' | 'local' | 'icp';

export interface Sheet {
	id: string;
	name: string;
	description: string | null;
	row_count: number;
	column_count: number;
	created_at: string;
	updated_at: string;
	/** Added by the storage adapter; not part of the API payload. */
	source: SheetSource;
	/** Whether the owning adapter accepts edits for this sheet. */
	writable: boolean;
}
