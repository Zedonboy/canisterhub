import { GridCellKind, type CustomCell, type CustomRenderer } from '@glideapps/glide-data-grid';
import type { FormulaResult, FormulaState } from '@/lib/formulas/formula-types';
import type { Column, FormulaCell } from '@/lib/types';
import { cellDisplayText, displayFormat, isNumericFormat } from '../cell-text';
import { ERROR_COLORS, pillColors, type PillColors } from '../palette';
import { drawPill, fontWith, truncateText } from './draw';

export interface FormulaCellData {
	kind: 'silver-formula';
	text: string;
	state: FormulaState;
	isError: boolean;
	align: 'left' | 'right';
	/** Text results with configured colours render as pills (e.g. "Reorder"). */
	pill?: PillColors;
}

export type FormulaGridCell = CustomCell<FormulaCellData>;

export function formulaCell(column: Column, cell: FormulaCell, result: FormulaResult): FormulaGridCell {
	const isError = result.state === 'error';
	const text = cellDisplayText(column, cell, result);
	const numeric = typeof result.value === 'number' && (isNumericFormat(displayFormat(column)) || displayFormat(column) === 'auto');
	const colorName =
		!isError && typeof result.value === 'string'
			? (column.settings.colors?.[result.value] ??
				column.settings.options?.find((option) => option.value === result.value)?.color)
			: undefined;

	return {
		kind: GridCellKind.Custom,
		allowOverlay: false,
		readonly: true,
		copyData: text,
		data: {
			kind: 'silver-formula',
			text,
			state: result.state,
			isError,
			align: numeric ? 'right' : 'left',
			pill: colorName ? pillColors(colorName, text) : undefined
		}
	};
}

const isPending = (state: FormulaState) => state === 'loading-dependencies' || state === 'evaluating';

export const formulaRenderer: CustomRenderer<FormulaGridCell> = {
	kind: GridCellKind.Custom,
	isMatch: (cell): cell is FormulaGridCell => (cell.data as { kind?: string }).kind === 'silver-formula',
	draw: ({ ctx, rect, theme }, cell) => {
		const { text, state, isError, align, pill } = cell.data;
		const padding = theme.cellHorizontalPadding;
		const cy = rect.y + rect.height / 2;

		// Subtle corner mark identifies computed cells.
		ctx.fillStyle = isError ? 'rgba(220, 38, 38, 0.55)' : 'rgba(37, 99, 235, 0.35)';
		ctx.beginPath();
		ctx.moveTo(rect.x + rect.width - 7, rect.y + 1);
		ctx.lineTo(rect.x + rect.width - 1, rect.y + 1);
		ctx.lineTo(rect.x + rect.width - 1, rect.y + 7);
		ctx.closePath();
		ctx.fill();

		if (isError) {
			drawPill(ctx, rect, padding, text, ERROR_COLORS, {
				font: `600 11.5px ui-monospace, SFMono-Regular, Menlo, monospace`,
				align
			});
			return;
		}

		if (pill && text) {
			drawPill(ctx, rect, padding, text, pill, { font: fontWith(500, `12px ${theme.fontFamily}`), dot: true });
			return;
		}

		const pending = isPending(state);
		if (pending) {
			// Dependencies loading: keep the cached value visible, dimmed, with a dot.
			ctx.fillStyle = theme.accentColor;
			ctx.beginPath();
			ctx.arc(rect.x + padding / 2 + 1, cy, 2.5, 0, Math.PI * 2);
			ctx.fill();
		}

		if (!text) return;
		ctx.font = theme.baseFontFull;
		ctx.textBaseline = 'middle';
		ctx.fillStyle = pending ? theme.textLight : theme.textDark;
		const shown = truncateText(ctx, text, rect.width - padding * 2);
		const x = align === 'right' ? rect.x + rect.width - padding - ctx.measureText(shown).width : rect.x + padding;
		ctx.fillText(shown, x, cy);
	},
	measure: (ctx, cell, theme) => ctx.measureText(cell.data.text).width + theme.cellHorizontalPadding * 2
};
