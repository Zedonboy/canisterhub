import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSheetSearch, type SheetSearch } from '@/lib/stores/sheet-search';

/** Ported from components/sheet-viewer/SheetSearchInput.svelte. */
export function SheetSearchInput({ search: searchProp }: { search: SheetSearch }) {
	const search = useSheetSearch(searchProp);

	function onKeydown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'Enter') {
			event.preventDefault();
			if (event.shiftKey) search.previous();
			else search.next();
		} else if (event.key === 'Escape') {
			search.query = '';
		}
	}

	const counter = search.matches.length === 0 ? '0' : `${search.activeIndex + 1}/${search.matches.length}${search.truncated ? '+' : ''}`;

	return (
		<div className="relative flex items-center">
			<Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
			<Input
				value={search.query}
				onChange={(event) => (search.query = event.target.value)}
				onKeyDown={onKeydown}
				placeholder="Search loaded rows"
				className="h-8 w-56 pr-24 pl-8 text-sm lg:w-64"
				aria-label="Search loaded rows"
			/>
			{search.query && (
				<div className="absolute right-1 flex items-center">
					<span className="px-1 text-xs text-muted-foreground tabular-nums">{counter}</span>
					<Button variant="ghost" size="icon" className="size-6" onClick={() => search.previous()} aria-label="Previous match">
						<ChevronUp className="size-3.5" />
					</Button>
					<Button variant="ghost" size="icon" className="size-6" onClick={() => search.next()} aria-label="Next match">
						<ChevronDown className="size-3.5" />
					</Button>
					<Button variant="ghost" size="icon" className="size-6" onClick={() => (search.query = '')} aria-label="Clear search">
						<X className="size-3.5" />
					</Button>
				</div>
			)}
		</div>
	);
}
