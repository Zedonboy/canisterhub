import type { Theme } from '@glideapps/glide-data-grid';

export const GRID_FONT_FAMILY =
	'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const HEADER_HEIGHT = 36;

const sharedTheme: Partial<Theme> = {
	cellHorizontalPadding: 10,
	cellVerticalPadding: 4,
	headerFontStyle: '600 12px',
	headerIconSize: 16,
	baseFontStyle: '13px',
	markerFontStyle: '11px',
	fontFamily: GRID_FONT_FAMILY,
	editorFontSize: '13px',
	lineHeight: 1.4,
	roundingRadius: 6
};

/** Glide theme aligned with the app's zinc/blue Tailwind palette. */
export const gridTheme: Partial<Theme> = {
	...sharedTheme,
	accentColor: '#2563eb',
	accentFg: '#ffffff',
	accentLight: 'rgba(37, 99, 235, 0.09)',
	textDark: '#18181b',
	textMedium: '#52525b',
	textLight: '#a1a1aa',
	textBubble: '#18181b',
	bgIconHeader: '#71717a',
	fgIconHeader: '#ffffff',
	textHeader: '#3f3f46',
	textHeaderSelected: '#ffffff',
	bgCell: '#ffffff',
	bgCellMedium: '#fafafa',
	bgHeader: '#fafafa',
	bgHeaderHasFocus: '#f4f4f5',
	bgHeaderHovered: '#f4f4f5',
	bgBubble: '#f4f4f5',
	bgBubbleSelected: '#ffffff',
	bgSearchResult: 'rgba(250, 204, 21, 0.35)',
	borderColor: 'rgba(24, 24, 27, 0.08)',
	horizontalBorderColor: 'rgba(24, 24, 27, 0.06)',
	headerBottomBorderColor: 'rgba(24, 24, 27, 0.12)',
	drilldownBorder: 'rgba(24, 24, 27, 0.16)',
	linkColor: '#2563eb'
};

/** Dark counterpart, matched to the `.dark` tokens in routes/layout.css. */
export const darkGridTheme: Partial<Theme> = {
	...sharedTheme,
	accentColor: '#3b82f6',
	accentFg: '#ffffff',
	accentLight: 'rgba(59, 130, 246, 0.2)',
	textDark: '#f4f4f5',
	textMedium: '#a1a1aa',
	textLight: '#71717a',
	textBubble: '#e4e4e7',
	bgIconHeader: '#a1a1aa',
	fgIconHeader: '#18181b',
	textHeader: '#d4d4d8',
	textHeaderSelected: '#ffffff',
	bgCell: '#0a0a0a',
	bgCellMedium: '#141416',
	bgHeader: '#111113',
	bgHeaderHasFocus: '#232326',
	bgHeaderHovered: '#1c1c1f',
	bgBubble: '#27272a',
	bgBubbleSelected: '#3f3f46',
	bgSearchResult: 'rgba(250, 204, 21, 0.25)',
	borderColor: 'rgba(255, 255, 255, 0.08)',
	horizontalBorderColor: 'rgba(255, 255, 255, 0.06)',
	headerBottomBorderColor: 'rgba(255, 255, 255, 0.14)',
	drilldownBorder: 'rgba(255, 255, 255, 0.18)',
	linkColor: '#60a5fa'
};

/** Parent (hierarchy) rows read as section headers. */
export const parentRowTheme: Partial<Theme> = {
	bgCell: '#fcfcfd',
	baseFontStyle: '600 13px'
};

export const darkParentRowTheme: Partial<Theme> = {
	bgCell: '#121214',
	baseFontStyle: '600 13px'
};

export const searchHighlightColor = 'rgba(250, 204, 21, 0.28)';
export const activeSearchHighlightColor = 'rgba(234, 179, 8, 0.55)';
