import { GridCellKind, type CustomCell, type CustomRenderer } from '@glideapps/glide-data-grid';
import type { Column } from '@/lib/types';
import { avatarColor } from '../palette';
import { measureText, truncateText } from './draw';

export interface UserCellData {
	kind: 'silver-user';
	name: string;
	initials: string;
	color: string;
}

export type UserCell = CustomCell<UserCellData>;

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
	return letters.toUpperCase();
}

export function userCell(column: Column, userId: string): UserCell {
	const name = column.settings.users?.[userId]?.name ?? userId;
	return {
		kind: GridCellKind.Custom,
		allowOverlay: false,
		readonly: true,
		copyData: name,
		data: { kind: 'silver-user', name, initials: initialsOf(name), color: avatarColor(userId) }
	};
}

export const userRenderer: CustomRenderer<UserCell> = {
	kind: GridCellKind.Custom,
	isMatch: (cell): cell is UserCell => (cell.data as { kind?: string }).kind === 'silver-user',
	draw: ({ ctx, rect, theme }, cell) => {
		const { name, initials, color } = cell.data;
		const radius = Math.min(10, rect.height / 2 - 4);
		const cx = rect.x + theme.cellHorizontalPadding + radius;
		const cy = rect.y + rect.height / 2;

		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(cx, cy, radius, 0, Math.PI * 2);
		ctx.fill();

		ctx.textBaseline = 'middle';
		ctx.font = `600 ${Math.max(8, Math.round(radius * 0.9))}px ${theme.fontFamily}`;
		ctx.fillStyle = '#ffffff';
		ctx.fillText(initials, cx - measureText(ctx, initials) / 2, cy + 0.5);

		ctx.font = theme.baseFontFull;
		ctx.fillStyle = theme.textDark;
		const textX = cx + radius + 8;
		ctx.fillText(truncateText(ctx, name, rect.x + rect.width - textX - theme.cellHorizontalPadding), textX, cy);
	},
	measure: (ctx, cell, theme) => ctx.measureText(cell.data.name).width + theme.cellHorizontalPadding * 2 + 30
};
