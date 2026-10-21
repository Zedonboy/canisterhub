import { GridCellKind, type CustomCell, type CustomRenderer } from '@glideapps/glide-data-grid';
import type { Column } from '@/lib/types';
import { pillColors, type PillColors } from '../palette';
import { drawPill, fontWith } from './draw';

export interface PillCellData {
	kind: 'silver-pill';
	label: string;
	colors: PillColors;
}

export type PillCell = CustomCell<PillCellData>;

/** Colour of an enum option (or a text column's `colors` entry), else a stable fallback. */
export function selectColors(column: Column, label: string): PillColors {
	const option = column.settings.options?.find((candidate) => candidate.value === label);
	return pillColors(option?.color ?? column.settings.colors?.[label], label);
}

export function pillCell(column: Column, label: string): PillCell {
	return {
		kind: GridCellKind.Custom,
		allowOverlay: false,
		readonly: true,
		copyData: label,
		data: { kind: 'silver-pill', label, colors: selectColors(column, label) }
	};
}

export const pillRenderer: CustomRenderer<PillCell> = {
	kind: GridCellKind.Custom,
	isMatch: (cell): cell is PillCell => (cell.data as { kind?: string }).kind === 'silver-pill',
	draw: ({ ctx, rect, theme }, cell) => {
		if (!cell.data.label) return;
		drawPill(ctx, rect, theme.cellHorizontalPadding, cell.data.label, cell.data.colors, {
			font: fontWith(500, `12px ${theme.fontFamily}`),
			dot: true
		});
	},
	measure: (ctx, cell, theme) => ctx.measureText(cell.data.label).width + theme.cellHorizontalPadding * 2 + 30
};
