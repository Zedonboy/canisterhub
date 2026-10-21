import {
	AllCellRenderers,
	GridCellKind,
	type CustomCell,
	type CustomRenderer,
	type GridCell
} from '@glideapps/glide-data-grid';

/**
 * Glide cell kinds that Glide never opens an editor for (it requires
 * `isReadWriteCell`), so double-click, Enter and type-to-edit do nothing.
 */
export const GLIDE_READ_ONLY_KINDS: ReadonlySet<GridCellKind> = new Set([
	GridCellKind.Bubble,
	GridCellKind.Drilldown,
	GridCellKind.RowID,
	GridCellKind.Protected,
	GridCellKind.Image
]);

export interface NativeCellData {
	kind: 'silver-native';
	inner: GridCell;
}

export type NativeEditableCell = CustomCell<NativeCellData>;

const nativeRenderers = new Map(AllCellRenderers.map((renderer) => [renderer.kind, renderer]));

/**
 * In editable sheets, wraps a read-only Glide cell in a custom cell so Glide
 * treats it as editable, while still drawing it with Glide's own renderer.
 */
export function wrapNativeCell(cell: GridCell): NativeEditableCell {
	return {
		kind: GridCellKind.Custom,
		data: { kind: 'silver-native', inner: cell },
		copyData: cell.copyData ?? '',
		readonly: false,
		allowOverlay: true
	};
}

export const nativeEditableRenderer: CustomRenderer<NativeEditableCell> = {
	kind: GridCellKind.Custom,
	isMatch: (cell): cell is NativeEditableCell => (cell.data as { kind?: string }).kind === 'silver-native',
	draw: (args, cell) => {
		const inner = cell.data.inner;
		const renderer = nativeRenderers.get(inner.kind);
		if (!renderer) return;
		// Built-in text-like renderers rely on draw prep for font and colour.
		args.ctx.font = args.theme.baseFontFull;
		args.ctx.fillStyle = inner.kind === GridCellKind.RowID ? args.theme.textLight : args.theme.textDark;
		renderer.draw({ ...args, cell: inner } as never, inner as never);
	},
	measure: (ctx, cell, theme) =>
		nativeRenderers.get(cell.data.inner.kind)?.measure?.(ctx, cell.data.inner as never, theme) ?? 120
};
