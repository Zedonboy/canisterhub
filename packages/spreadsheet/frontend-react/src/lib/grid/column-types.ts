import { GridCellKind, GridColumnIcon, type CustomRenderer, type GridCell } from '@glideapps/glide-data-grid';
import type { FormulaResult } from '@/lib/formulas/formula-types';
import type { CellValue, Column, ColumnDataType, RowData } from '@/lib/types';
import { cellPrimitive, isFormulaCell } from '@/lib/types';
import { cellDisplayText } from './cell-text';
import {
	booleanCell,
	bubbleCell,
	currencyCell,
	dateCell,
	drilldownCell,
	imageCell,
	markdownCell,
	numberCell,
	protectedCell,
	rowIdCell,
	textCell,
	uriCell
} from './renderers/basic';
import { formulaCell, formulaRenderer } from './renderers/formula';
import { hierarchyRenderer, treeCell } from './renderers/hierarchy';
import { GLIDE_READ_ONLY_KINDS, nativeEditableRenderer, wrapNativeCell } from './renderers/native-editable';
import { pillCell, pillRenderer } from './renderers/select-pill';
import { userCell, userRenderer } from './renderers/user';

export interface CellContext {
	column: Column;
	row: RowData;
	value: CellValue | undefined;
	/** Present for formula cells. */
	formula?: FormulaResult;
	isPrimary: boolean;
	collapsed: boolean;
	/** Writable sheets get editable cells (overlay editor, checkbox toggles). */
	editable?: boolean;
}

export interface ColumnTypeDefinition {
	icon: GridColumnIcon | string;
	overlayIcon?: GridColumnIcon | string;
	defaultWidth: number;
	/** Builds the cell for a non-formula value. */
	createCell(context: CellContext): GridCell;
}

const registry = new Map<string, ColumnTypeDefinition>();

/** Adds or replaces a column type; unknown backend types fall back to text. */
export function registerColumnType(type: ColumnDataType, definition: ColumnTypeDefinition) {
	registry.set(type, definition);
}

export function getColumnType(type: ColumnDataType): ColumnTypeDefinition {
	return registry.get(type) ?? registry.get('text')!;
}

const primitive = (context: CellContext) => cellPrimitive(context.value);

// -- Glide cell kinds (https://docs.grid.glideapps.com/api/cells) -------------------

registerColumnType('text', {
	icon: GridColumnIcon.HeaderString,
	defaultWidth: 180,
	createCell: (c) => textCell(c.column, primitive(c))
});
registerColumnType('number', {
	icon: GridColumnIcon.HeaderNumber,
	defaultWidth: 120,
	createCell: (c) => numberCell(c.column, primitive(c))
});
registerColumnType('boolean', {
	icon: GridColumnIcon.HeaderBoolean,
	defaultWidth: 100,
	createCell: (c) => booleanCell(c.column, primitive(c))
});
registerColumnType('uri', {
	icon: GridColumnIcon.HeaderUri,
	defaultWidth: 200,
	createCell: (c) => uriCell(primitive(c), c.editable ?? false)
});
registerColumnType('image', {
	icon: GridColumnIcon.HeaderImage,
	defaultWidth: 140,
	createCell: (c) => imageCell(c.value)
});
registerColumnType('markdown', {
	icon: GridColumnIcon.HeaderMarkdown,
	defaultWidth: 260,
	createCell: (c) => markdownCell(primitive(c))
});
registerColumnType('bubble', {
	icon: GridColumnIcon.HeaderArray,
	defaultWidth: 200,
	createCell: (c) => bubbleCell(c.value)
});
registerColumnType('drilldown', {
	icon: GridColumnIcon.HeaderLookup,
	defaultWidth: 220,
	createCell: (c) => drilldownCell(c.value)
});
registerColumnType('row-id', {
	icon: GridColumnIcon.HeaderRowID,
	defaultWidth: 140,
	createCell: (c) => rowIdCell(primitive(c))
});
registerColumnType('protected', {
	icon: GridColumnIcon.HeaderString,
	overlayIcon: GridColumnIcon.ProtectedColumnOverlay,
	defaultWidth: 140,
	createCell: (c) => protectedCell(c.column, primitive(c))
});

// -- IntelliSheet custom types ------------------------------------------------------------

registerColumnType('currency', {
	icon: GridColumnIcon.HeaderNumber,
	defaultWidth: 140,
	createCell: (c) => currencyCell(c.column, primitive(c))
});
registerColumnType('date', {
	icon: GridColumnIcon.HeaderDate,
	defaultWidth: 130,
	createCell: (c) => dateCell(c.column, primitive(c))
});
registerColumnType('enum', {
	icon: GridColumnIcon.HeaderSingleValue,
	defaultWidth: 150,
	createCell: (c) => {
		const value = primitive(c);
		return value === null || value === '' ? textCell(c.column, null) : pillCell(c.column, String(value));
	}
});
registerColumnType('user', {
	icon: GridColumnIcon.HeaderEmail,
	defaultWidth: 170,
	createCell: (c) => {
		const value = primitive(c);
		return typeof value === 'string' && value ? userCell(c.column, value) : textCell(c.column, null);
	}
});

/** Canvas renderers for IntelliSheet's custom cell kinds. */
export const customRenderers: readonly CustomRenderer<any>[] = [
	hierarchyRenderer,
	formulaRenderer,
	pillRenderer,
	userRenderer,
	nativeEditableRenderer
];

export function createGridCell(context: CellContext): GridCell {
	const cell = buildCell(context);
	return context.editable ? makeEditable(cell) : cell;
}

function buildCell(context: CellContext): GridCell {
	const { column, row, value, formula } = context;

	if (context.isPrimary) {
		const text = cellDisplayText(column, value, formula);
		return treeCell(text, row.depth, row.has_children, context.collapsed);
	}

	if (isFormulaCell(value) && formula && column.data_type !== 'protected') {
		return formulaCell(column, value, formula);
	}

	return getColumnType(column.data_type).createCell(context);
}

/**
 * Every editable cell opens IntelliSheet's overlay editors (text, enum, markdown,
 * secret); checkboxes toggle in place. Kinds Glide refuses to edit (Bubble,
 * Drilldown, RowID, Protected, Image) are wrapped so they stay natively drawn
 * but become editable.
 */
function makeEditable(cell: GridCell): GridCell {
	if (GLIDE_READ_ONLY_KINDS.has(cell.kind)) return wrapNativeCell(cell);
	switch (cell.kind) {
		case GridCellKind.Loading:
			return cell;
		case GridCellKind.Boolean:
			return { ...cell, readonly: false };
		default:
			return { ...cell, readonly: false, allowOverlay: true } as GridCell;
	}
}
