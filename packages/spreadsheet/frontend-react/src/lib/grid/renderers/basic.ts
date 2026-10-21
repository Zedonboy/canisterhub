import { GridCellKind, type GridCell } from '@glideapps/glide-data-grid';
import type { CellPrimitive, CellValue, Column } from '@/lib/types';
import { isSafeImageUrl, safeHref, toDrilldownItems, toStringList } from '@/lib/utils/cell-values';
import { formatPrimitive } from '../cell-text';

/**
 * Cells built on Glide's native cell kinds (one per kind in the Glide docs).
 * Every cell is created read-only; `makeEditable` in column-types.ts unlocks
 * cells for writable sheets and routes editing through IntelliSheet's editors.
 */

export function textCell(column: Column, value: CellPrimitive): GridCell {
	const text = formatPrimitive(column, value, 'text');
	return {
		kind: GridCellKind.Text,
		data: text,
		displayData: text,
		readonly: true,
		allowOverlay: text.length > 24
	};
}

function numericCell(column: Column, value: CellPrimitive, format: 'number' | 'currency'): GridCell {
	if (typeof value !== 'number') return textCell(column, value);
	return {
		kind: GridCellKind.Number,
		data: value,
		displayData: formatPrimitive(column, value, format),
		readonly: true,
		allowOverlay: false,
		contentAlign: 'right',
		copyData: String(value)
	};
}

export const numberCell = (column: Column, value: CellPrimitive) => numericCell(column, value, 'number');

export const currencyCell = (column: Column, value: CellPrimitive) => numericCell(column, value, 'currency');

export function dateCell(column: Column, value: CellPrimitive): GridCell {
	const text = typeof value === 'string' ? formatPrimitive(column, value, 'date') : formatPrimitive(column, value);
	return {
		kind: GridCellKind.Text,
		data: text,
		displayData: text,
		readonly: true,
		allowOverlay: false,
		copyData: value === null ? '' : String(value)
	};
}

export function booleanCell(_column: Column, value: CellPrimitive): GridCell {
	return {
		kind: GridCellKind.Boolean,
		data: value === null ? null : Boolean(value),
		readonly: true,
		allowOverlay: false,
		contentAlign: 'center'
	};
}

/**
 * Clickable link. Only http(s)/mailto links open. In editable sheets a plain
 * click selects the cell for editing, so opening needs Ctrl/⌘-click.
 */
export function uriCell(value: CellPrimitive, editable: boolean): GridCell {
	const uri = value === null ? '' : String(value);
	const href = safeHref(uri);
	return {
		kind: GridCellKind.Uri,
		data: uri,
		displayData: uri.replace(/^https?:\/\//, ''),
		readonly: true,
		allowOverlay: false,
		hoverEffect: href !== null,
		copyData: uri,
		onClickUri: href
			? (args) => {
					if (editable && !args.ctrlKey && !args.metaKey) return;
					args.preventDefault();
					window.open(href, '_blank', 'noopener,noreferrer');
				}
			: undefined
	};
}

export function imageCell(value: CellValue | undefined): GridCell {
	const urls = toStringList(value).filter(isSafeImageUrl);
	return {
		kind: GridCellKind.Image,
		data: urls,
		readonly: true,
		allowOverlay: false,
		rounding: 4,
		copyData: urls.join(', ')
	};
}

/**
 * Markdown text. The read-only overlay is disabled because Glide renders it as
 * HTML; editing uses IntelliSheet's plain textarea editor instead.
 */
export function markdownCell(value: CellPrimitive): GridCell {
	const text = value === null ? '' : String(value);
	return { kind: GridCellKind.Markdown, data: text, readonly: true, allowOverlay: false, copyData: text };
}

export function bubbleCell(value: CellValue | undefined): GridCell {
	const tags = toStringList(value);
	return { kind: GridCellKind.Bubble, data: tags, allowOverlay: false, copyData: tags.join(', ') };
}

export function drilldownCell(value: CellValue | undefined): GridCell {
	const items = toDrilldownItems(value).map((item) =>
		item.img && isSafeImageUrl(item.img) ? item : { text: item.text }
	);
	return {
		kind: GridCellKind.Drilldown,
		data: items,
		allowOverlay: false,
		copyData: items.map((item) => item.text).join(', ')
	};
}

export function rowIdCell(value: CellPrimitive): GridCell {
	const text = value === null ? '' : String(value);
	return { kind: GridCellKind.RowID, data: text, readonly: true, allowOverlay: false, copyData: text };
}

/** Masked value: never exposes its content through display or copy. */
export function protectedCell(column: Column, value: CellPrimitive): GridCell {
	if (value === null || value === '') return textCell(column, null);
	return { kind: GridCellKind.Protected, allowOverlay: false, copyData: '' };
}

export const loadingCell: GridCell = {
	kind: GridCellKind.Loading,
	allowOverlay: false,
	skeletonWidth: 90,
	skeletonWidthVariability: 45,
	skeletonHeight: 10
};
