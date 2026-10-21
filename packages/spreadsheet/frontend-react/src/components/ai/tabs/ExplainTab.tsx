import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAiActivityStore } from '@/stores/ai-activity';
import { buildSheetContext } from '@/lib/ai/context';
import { ai } from '@/lib/ai/provider';
import type { SheetBrief } from '@/lib/ai/types';
import { errorMessage, timeLabel } from '@/lib/ai/ui';
import type { Column, Sheet } from '@/lib/types';

/** Ported from components/ai/tabs/ExplainTab.svelte. `onMount` becomes a mount-only `useEffect`. */
export function ExplainTab({ sheet, columns }: { sheet: Sheet; columns: Column[] }) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [brief, setBrief] = useState<SheetBrief | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const storageKey = `silver:ai:brief:${sheet.id}`;

	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
			if (saved?.brief) {
				setBrief(saved.brief);
				setGeneratedAt(saved.generatedAt);
			}
		} catch {
			// No saved brief.
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [storageKey]);

	async function explain() {
		setRunning(true);
		setError(null);
		try {
			const context = await buildSheetContext(sheet, columns);
			const result = await runAiActivity('explain-sheet', sheet.name, () => ai.explainSheet(context), (r) => r.purpose);
			const at = new Date().toISOString();
			setBrief(result);
			setGeneratedAt(at);
			try {
				localStorage.setItem(storageKey, JSON.stringify({ brief: result, generatedAt: at }));
			} catch {
				// Brief stays on screen even if it can't be saved.
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	async function copy() {
		if (!brief) return;
		const text = [brief.purpose, ...brief.sections.map((section) => `${section.title}\n${section.items.map((item) => `• ${item}`).join('\n')}`)].join('\n\n');
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2_000);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<div className="grid gap-0.5">
					<h3 className="text-sm font-medium">Explain this sheet</h3>
					<p className="text-xs text-muted-foreground">
						A plain-language brief of what the sheet is for, its columns and how its numbers are calculated. Saved with the sheet in this browser.
					</p>
				</div>
				<Button size="sm" variant={brief ? 'outline' : 'default'} disabled={running} onClick={explain}>
					{running ? 'Writing…' : brief ? 'Rewrite' : 'Explain'}
				</Button>
			</div>

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{brief && (
				<article className="grid gap-4 rounded-lg border p-4">
					<div className="flex items-start justify-between gap-3">
						<p className="text-sm leading-relaxed">{brief.purpose}</p>
						<Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy brief" title={copied ? 'Copied' : 'Copy brief'}>
							<Copy className="size-4" />
						</Button>
					</div>
					{brief.sections.map((section) => (
						<section key={section.title} className="grid gap-1.5">
							<h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{section.title}</h4>
							<ul className="grid gap-1 pl-4 text-sm leading-relaxed">
								{section.items.map((item, index) => (
									<li key={index} className="list-disc">
										{item}
									</li>
								))}
							</ul>
						</section>
					))}
					{generatedAt && (
						<p className="text-[11px] text-muted-foreground">
							Written {timeLabel(generatedAt)}
							{copied ? ' · Copied' : ''}
						</p>
					)}
				</article>
			)}
		</div>
	);
}
