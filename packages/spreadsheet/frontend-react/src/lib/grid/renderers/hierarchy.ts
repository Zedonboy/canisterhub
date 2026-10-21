import { GridCellKind, type CustomCell, type CustomRenderer } from '@glideapps/glide-data-grid';
import { fontWith, truncateText } from './draw';

export const TREE_INDENT = 18;
const TOGGLE_SIZE = 16;

export interface TreeCellData {
	kind: 'silver-tree';
	text: string;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
}

export type TreeCell = CustomCell<TreeCellData>;

export function treeCell(text: string, depth: number, hasChildren: boolean, collapsed: boolean): TreeCell {
	return {
		kind: GridCellKind.Custom,
		allowOverlay: false,
		readonly: true,
		copyData: text,
		cursor: hasChildren ? 'pointer' : undefined,
		data: { kind: 'silver-tree', text, depth, hasChildren, collapsed }
	};
}

/** Horizontal hit area (cell-local px) of the expand/collapse toggle. */
export function toggleHitArea(depth: number, padding: number): [number, number] {
	const start = padding + depth * TREE_INDENT;
	return [start - 4, start + TOGGLE_SIZE + 4];
}

export const hierarchyRenderer: CustomRenderer<TreeCell> = {
	kind: GridCellKind.Custom,
	isMatch: (cell): cell is TreeCell => (cell.data as { kind?: string }).kind === 'silver-tree',
	draw: ({ ctx, rect, theme }, cell) => {
		const { text, depth, hasChildren, collapsed } = cell.data;
		const padding = theme.cellHorizontalPadding;
		const cy = rect.y + rect.height / 2;
		const toggleX = rect.x + padding + depth * TREE_INDENT;

		// Indentation guides for nested rows.
		if (depth > 0) {
			ctx.strokeStyle = theme.borderColor;
			ctx.lineWidth = 1;
			for (let level = 0; level < depth; level++) {
				const gx = Math.round(rect.x + padding + level * TREE_INDENT + TOGGLE_SIZE / 2) + 0.5;
				ctx.beginPath();
				ctx.moveTo(gx, rect.y);
				ctx.lineTo(gx, rect.y + rect.height);
				ctx.stroke();
			}
		}

		if (hasChildren) {
			const cx = toggleX + TOGGLE_SIZE / 2;
			ctx.strokeStyle = theme.textMedium;
			ctx.lineWidth = 1.6;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			ctx.beginPath();
			if (collapsed) {
				ctx.moveTo(cx - 2, cy - 4);
				ctx.lineTo(cx + 2, cy);
				ctx.lineTo(cx - 2, cy + 4);
			} else {
				ctx.moveTo(cx - 4, cy - 2);
				ctx.lineTo(cx, cy + 2);
				ctx.lineTo(cx + 4, cy - 2);
			}
			ctx.stroke();
		}

		const textX = toggleX + TOGGLE_SIZE + 6;
		ctx.font = hasChildren ? fontWith(600, theme.baseFontFull) : theme.baseFontFull;
		ctx.fillStyle = theme.textDark;
		ctx.textBaseline = 'middle';
		ctx.fillText(truncateText(ctx, text, rect.x + rect.width - textX - padding), textX, cy);
	},
	measure: (ctx, cell, theme) =>
		ctx.measureText(cell.data.text).width + theme.cellHorizontalPadding * 2 + cell.data.depth * TREE_INDENT + TOGGLE_SIZE + 6
};
