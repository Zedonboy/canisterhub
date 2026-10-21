import { CornerDownLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAiActivityStore } from '@/stores/ai-activity';
import { buildSheetContext, sheetTools } from '@/lib/ai/context';
import { suggestedQuestions } from '@/lib/ai/mock/ask';
import { ai } from '@/lib/ai/provider';
import type { AskAnswer, SheetContext } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import type { Column, Sheet } from '@/lib/types';
import { RowChips } from '../RowChips';

/** Ported from components/ai/tabs/AskTab.svelte. */
export function AskTab({ sheet, columns, onRevealRow }: { sheet: Sheet; columns: Column[]; onRevealRow: (position: number, columnKey?: string) => void }) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [question, setQuestion] = useState('');
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<{ id: number; question: string; answer: AskAnswer }[]>([]);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	// Not component state: caching the built context doesn't need to trigger a re-render.
	const context = useRef<SheetContext | null>(null);
	const nextId = useRef(0);

	async function ensureContext(): Promise<SheetContext> {
		context.current ??= await buildSheetContext(sheet, columns);
		return context.current;
	}

	useEffect(() => {
		let cancelled = false;
		ensureContext()
			.then((built) => {
				if (!cancelled) setSuggestions(suggestedQuestions(built));
			})
			.catch(() => {
				if (!cancelled) setSuggestions([]);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function ask(text = question) {
		const value = text.trim();
		if (!value || running) return;
		setRunning(true);
		setError(null);
		try {
			const current = await ensureContext();
			const answer = await runAiActivity('ask', sheet.name, () => ai.ask(value, current, sheetTools(sheet.id, columns)), (result) => result.answer);
			setHistory((prev) => [{ id: nextId.current++, question: value, answer }, ...prev]);
			setQuestion('');
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<form
				className="grid gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void ask();
				}}
			>
				<label htmlFor="ai-question" className="text-sm font-medium">
					Ask about this sheet
				</label>
				<Textarea
					id="ai-question"
					value={question}
					onChange={(event) => setQuestion(event.target.value)}
					rows={2}
					placeholder="e.g. How many rows have Status Unpaid?"
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							void ask();
						}
					}}
				/>
				<div className="flex items-center justify-between gap-2">
					<p className="text-xs text-muted-foreground">Answers come from filters and totals run on the sheet, not from guessing.</p>
					<Button type="submit" size="sm" disabled={!question.trim() || running}>
						<CornerDownLeft className="size-3.5" />
						{running ? 'Thinking…' : 'Ask'}
					</Button>
				</div>
			</form>

			{suggestions.length > 0 && history.length === 0 && (
				<div className="flex flex-wrap gap-1.5">
					{suggestions.map((suggestion) => (
						<button
							key={suggestion}
							type="button"
							className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:border-violet-300 hover:bg-violet-50 hover:text-foreground"
							disabled={running}
							onClick={() => ask(suggestion)}
						>
							{suggestion}
						</button>
					))}
				</div>
			)}

			{error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

			{history.map((item) => (
				<article key={item.id} className="grid gap-2 rounded-lg border p-3">
					<p className="text-xs font-medium text-muted-foreground">{item.question}</p>
					<p className="text-sm leading-relaxed">{item.answer.answer}</p>
					{item.answer.caveat && <p className="text-xs text-amber-800">{item.answer.caveat}</p>}
					<RowChips rows={item.answer.rows} onRevealRow={onRevealRow} />
					{item.answer.steps.length > 0 && (
						<details className="text-xs">
							<summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">How this was worked out</summary>
							<ol className="mt-2 grid gap-1.5 border-l pl-3">
								{item.answer.steps.map((step, index) => (
									<li key={index} className="grid gap-0.5">
										<code className="font-mono text-[11px] text-violet-700">
											{step.tool}({step.args})
										</code>
										<span className="text-muted-foreground">→ {step.result}</span>
									</li>
								))}
							</ol>
						</details>
					)}
				</article>
			))}
		</div>
	);
}
