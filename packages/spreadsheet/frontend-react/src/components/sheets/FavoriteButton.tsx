import { Star } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useFavoritesStore } from '@/stores/favorites';
import { cn } from '@/lib/utils';

/** Ported from components/sheets/FavoriteButton.svelte. */
export function FavoriteButton({ sheetId, className }: { sheetId: string; className?: string }) {
	const active = useFavoritesStore((state) => state.has(sheetId));
	const toggle = useFavoritesStore((state) => state.toggle);

	function onClick(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		toggle(sheetId);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
				className
			)}
			aria-pressed={active}
			aria-label={active ? 'Unpin sheet' : 'Pin sheet'}
			title={active ? 'Unpin (saved in this browser)' : 'Pin (saved in this browser)'}
		>
			<Star className={cn('size-4', active && 'fill-amber-400 text-amber-400')} />
		</button>
	);
}
