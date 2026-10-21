import { theme } from '@/stores/theme';
import { OPTION_COLORS, type OptionColor } from '@/lib/types';

export interface PillColors {
	background: string;
	foreground: string;
	border: string;
}

const PALETTE: Record<OptionColor, PillColors> = {
	slate: { background: '#f4f4f5', foreground: '#3f3f46', border: '#e4e4e7' },
	blue: { background: '#eff6ff', foreground: '#1d4ed8', border: '#dbeafe' },
	green: { background: '#ecfdf5', foreground: '#047857', border: '#d1fae5' },
	red: { background: '#fef2f2', foreground: '#b91c1c', border: '#fee2e2' },
	amber: { background: '#fffbeb', foreground: '#b45309', border: '#fef3c7' },
	orange: { background: '#fff7ed', foreground: '#c2410c', border: '#ffedd5' },
	violet: { background: '#f5f3ff', foreground: '#6d28d9', border: '#ede9fe' },
	teal: { background: '#f0fdfa', foreground: '#0f766e', border: '#ccfbf1' },
	pink: { background: '#fdf2f8', foreground: '#be185d', border: '#fce7f3' }
};

/** Translucent tints with light text, readable on the dark grid. */
const DARK_PALETTE: Record<OptionColor, PillColors> = {
	slate: { background: 'rgba(161, 161, 170, 0.16)', foreground: '#d4d4d8', border: 'rgba(161, 161, 170, 0.28)' },
	blue: { background: 'rgba(59, 130, 246, 0.18)', foreground: '#93c5fd', border: 'rgba(59, 130, 246, 0.34)' },
	green: { background: 'rgba(16, 185, 129, 0.16)', foreground: '#6ee7b7', border: 'rgba(16, 185, 129, 0.32)' },
	red: { background: 'rgba(239, 68, 68, 0.18)', foreground: '#fca5a5', border: 'rgba(239, 68, 68, 0.34)' },
	amber: { background: 'rgba(245, 158, 11, 0.16)', foreground: '#fcd34d', border: 'rgba(245, 158, 11, 0.32)' },
	orange: { background: 'rgba(249, 115, 22, 0.16)', foreground: '#fdba74', border: 'rgba(249, 115, 22, 0.32)' },
	violet: { background: 'rgba(139, 92, 246, 0.2)', foreground: '#c4b5fd', border: 'rgba(139, 92, 246, 0.36)' },
	teal: { background: 'rgba(20, 184, 166, 0.16)', foreground: '#5eead4', border: 'rgba(20, 184, 166, 0.32)' },
	pink: { background: 'rgba(236, 72, 153, 0.16)', foreground: '#f9a8d4', border: 'rgba(236, 72, 153, 0.32)' }
};

const palette = () => (theme.dark ? DARK_PALETTE : PALETTE);

const FALLBACK_ORDER: OptionColor[] = ['blue', 'violet', 'teal', 'amber', 'green', 'orange', 'pink', 'slate'];

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#059669', '#ea580c', '#db2777', '#4f46e5'];

/** Formula error pills; follows the current theme. */
export const ERROR_COLORS: PillColors = {
	get background() {
		return palette().red.background;
	},
	get foreground() {
		return palette().red.foreground;
	},
	get border() {
		return palette().red.border;
	}
};

export function isOptionColor(name: unknown): name is OptionColor {
	return typeof name === 'string' && (OPTION_COLORS as readonly string[]).includes(name);
}

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/** Named palette colour, or a stable colour derived from the label. */
export function pillColors(name: string | undefined, label: string): PillColors {
	if (isOptionColor(name)) return palette()[name];
	return palette()[FALLBACK_ORDER[hash(label) % FALLBACK_ORDER.length]];
}

/** Colour suggested for the n-th option of a new enum. */
export function defaultOptionColor(index: number): OptionColor {
	return FALLBACK_ORDER[index % FALLBACK_ORDER.length];
}

export function avatarColor(seed: string): string {
	return AVATAR_COLORS[hash(seed) % AVATAR_COLORS.length];
}
