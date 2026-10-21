import { Check, Copy, Search } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import type { FormulaFunction } from '@/lib/formulas/function-catalog';
import { cn } from '@/lib/utils';

const ALL = 'all';

function FormulaBlock({ text, result, id, copied, onCopy }: { text: string; result: string | undefined; id: string; copied: string | null; onCopy: (text: string, key: string) => void }) {
	return (
		<div className="overflow-hidden rounded-md border">
			<div className="flex items-start gap-2 bg-muted/50 py-1.5 pr-1.5 pl-3">
				<code className="min-w-0 flex-1 py-0.5 font-mono text-[13px] break-words text-blue-700">{text}</code>
				<Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={() => onCopy(text, id)} aria-label={`Copy ${text}`}>
					{copied === id ? (
						<>
							<Check className="size-3.5" /> Copied
						</>
					) : (
						<>
							<Copy className="size-3.5" /> Copy
						</>
					)}
				</Button>
			</div>
			{result !== undefined && (
				<div className="flex items-baseline gap-3 border-t px-3 py-2">
					<span className="text-xs text-muted-foreground">Result</span>
					<span className="font-mono text-[13px] font-medium break-all">{result}</span>
				</div>
			)}
		</div>
	);
}

/**
 * Ported from components/sheet-viewer/FunctionReferenceDialog.svelte. The
 * catalogue still loads lazily on first open via a dynamic `import()`, the
 * same code-splitting trick Vite honors as well as SvelteKit did.
 */
export function FunctionReferenceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [catalog, setCatalog] = useState<{ functions: FormulaFunction[]; categories: string[] } | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState(ALL);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const list = useRef<HTMLDivElement | null>(null);

	// The catalogue (400+ entries) loads on first open, keeping it out of the sheet bundle.
	useEffect(() => {
		if (!open || catalog) return;
		import('@/lib/formulas/function-catalog')
			.then((module) => setCatalog({ functions: module.FORMULA_FUNCTIONS, categories: module.FUNCTION_CATEGORIES }))
			.catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, catalog]);

	const counts = new Map<string, number>();
	for (const fn of catalog?.functions ?? []) counts.set(fn.category, (counts.get(fn.category) ?? 0) + 1);

	/** Name matches first (exact, then prefix, then anywhere), then matches in the description. */
	const inCategory = (catalog?.functions ?? []).filter((fn) => category === ALL || fn.category === category);
	const needle = query.trim().toUpperCase();
	const results = !needle
		? inCategory
		: inCategory
				.map((fn) => {
					let score = 0;
					const words = needle.toLowerCase().split(/\s+/);
					if (fn.name === needle) score = 100;
					else if (fn.name.startsWith(needle)) score = 80 - fn.name.length / 100;
					else if (fn.name.includes(needle)) score = 60;
					else if (words.every((word) => `${fn.description} ${fn.category}`.toLowerCase().includes(word))) score = 30;
					return { fn, score };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score || a.fn.name.localeCompare(b.fn.name))
				.map((match) => match.fn);

	const selected = results.find((fn) => fn.name === selectedName) ?? results[0] ?? null;

	function select(fn: FormulaFunction) {
		setSelectedName(fn.name);
		requestAnimationFrame(() => {
			list.current?.querySelector(`[data-name="${CSS.escape(fn.name)}"]`)?.scrollIntoView({ block: 'nearest' });
		});
	}

	/** Arrow keys in the search box move through the results. */
	function onSearchKeydown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const index = selected ? results.indexOf(selected) : -1;
		const next = results[Math.min(results.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
		if (next) select(next);
	}

	async function copy(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(key);
			setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
		} catch {
			setCopied(null);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex h-[min(88vh,46rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					document.getElementById('function-search')?.focus();
				}}
			>
				<div className="grid gap-3 border-b p-4 pr-12">
					<DialogHeader>
						<DialogTitle>Formula functions</DialogTitle>
						<DialogDescription>
							{catalog ? `${catalog.functions.length} functions` : 'Functions'} you can use in formulas. Search by name or by what you want to do.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative flex-1">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								id="function-search"
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={onSearchKeydown}
								placeholder="Search, e.g. VLOOKUP or “working days”"
								autoComplete="off"
								spellCheck="false"
								aria-controls="function-list"
								className="pl-8"
							/>
						</div>
						<Select value={category} onValueChange={(value) => setCategory(value || ALL)}>
							<SelectTrigger className="w-full sm:w-56" aria-label="Category">
								{category === ALL ? 'All categories' : category}
							</SelectTrigger>
							<SelectContent className="max-h-80">
								<SelectItem value={ALL}>
									All categories
									<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{catalog?.functions.length ?? ''}</span>
								</SelectItem>
								{(catalog?.categories ?? []).map((name) => (
									<SelectItem key={name} value={name}>
										{name}
										<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{counts.get(name) ?? 0}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-1">
					<div id="function-list" ref={list} className="min-h-0 overflow-y-auto border-b md:border-r md:border-b-0" role="listbox" aria-label="Functions">
						{loadError ? (
							<p className="p-4 text-sm text-red-700">Couldn't load the function list: {loadError}</p>
						) : !catalog ? (
							<p className="p-4 text-sm text-muted-foreground">Loading functions…</p>
						) : results.length === 0 ? (
							<p className="p-4 text-sm text-muted-foreground">
								No functions match “{query.trim()}”{category === ALL ? '' : ` in ${category}`}.
							</p>
						) : (
							results.map((fn) => (
								<button
									key={fn.name}
									type="button"
									role="option"
									aria-selected={fn === selected}
									data-name={fn.name}
									onClick={() => setSelectedName(fn.name)}
									className={cn(
										'flex w-full flex-col items-start gap-0.5 border-b border-border/60 px-4 py-2 text-left transition-colors hover:bg-muted/60',
										fn === selected && 'bg-muted hover:bg-muted'
									)}
								>
									<span className="font-mono text-[13px] font-medium">{fn.name}</span>
									<span className="line-clamp-1 text-xs text-muted-foreground">{fn.description}</span>
								</button>
							))
						)}
					</div>

					<div className="min-h-0 overflow-y-auto p-5">
						{selected ? (
							<article className="grid max-w-2xl gap-5">
								<header className="grid gap-2">
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="font-mono text-lg font-semibold">{selected.name}</h3>
										<span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{selected.category}</span>
									</div>
									<p className="text-sm leading-relaxed">{selected.description}</p>
								</header>

								<section className="grid gap-1.5">
									<h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Syntax</h4>
									<code className="block rounded-md bg-muted px-3 py-2 font-mono text-[13px] break-words whitespace-pre-wrap">{selected.syntax}</code>
									{/\[[a-z]/.test(selected.syntax) && <p className="text-xs text-muted-foreground">Arguments in [brackets] are optional.</p>}
								</section>

								{selected.note && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">{selected.note}</p>}

								<section className="grid gap-1.5">
									<h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Example</h4>
									<FormulaBlock text={selected.example} result={selected.result} id={`example:${selected.name}`} copied={copied} onCopy={copy} />
								</section>

								{selected.sheetExample && (
									<section className="grid gap-1.5">
										<h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">In a sheet</h4>
										<FormulaBlock text={selected.sheetExample} result={undefined} id={`sheet:${selected.name}`} copied={copied} onCopy={copy} />
										<p className="text-xs text-muted-foreground">
											<code className="font-mono">[Column]@row</code> is the cell in the same row; <code className="font-mono">[Column]:[Column]</code> is the whole column.
										</p>
									</section>
								)}
							</article>
						) : (
							catalog && <p className="text-sm text-muted-foreground">Pick a function to see how to use it.</p>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
