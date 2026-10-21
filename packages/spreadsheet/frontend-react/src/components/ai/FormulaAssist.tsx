import { Sparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAiActivityStore } from '@/stores/ai-activity';
import { ai } from '@/lib/ai/provider';
import type { FormulaExplanation, FormulaFix, FormulaSuggestion } from '@/lib/ai/types';
import { errorMessage } from '@/lib/ai/ui';
import type { SelectedCellInfo } from '@/lib/grid/sheet-grid-controller';
import type { Column } from '@/lib/types';
import { MockAiBadge } from './MockAiBadge';

/** Ported from components/ai/FormulaAssist.svelte. Used by FormulaBar (Phase 6e). */
export function FormulaAssist({
	selected,
	columns,
	canInsert,
	onInsert
}: {
	selected: SelectedCellInfo;
	columns: Column[];
	/** False for view-only sheets and column-formula cells: explain only. */
	canInsert: boolean;
	onInsert: (formula: string) => void;
}) {
	const runAiActivity = useAiActivityStore((state) => state.run);

	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState('');
	const [running, setRunning] = useState<'write' | 'explain' | 'fix' | null>(null);
	const [suggestion, setSuggestion] = useState<FormulaSuggestion | null>(null);
	const [explanation, setExplanation] = useState<FormulaExplanation | null>(null);
	const [fix, setFix] = useState<FormulaFix | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	const errorCode = selected.result?.state === 'error' ? (selected.result.error?.code ?? null) : null;
	const target = columns.find((column) => column.key === selected.columnKey);
	const cellKey = `${selected.rowId} ${selected.columnKey} ${selected.formula ?? ''}`;

	// A different cell starts a fresh conversation.
	useEffect(() => {
		setSuggestion(null);
		setExplanation(null);
		setFix(undefined);
		setError(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cellKey]);

	async function write() {
		if (!prompt.trim()) return;
		setRunning('write');
		setError(null);
		try {
			setSuggestion(await runAiActivity('formula-write', null, () => ai.writeFormula(prompt, columns, target), (result) => result.formula || 'No formula'));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(null);
		}
	}

	async function explain() {
		if (!selected.formula) return;
		const formula = selected.formula;
		setRunning('explain');
		setError(null);
		try {
			setExplanation(await runAiActivity('formula-explain', null, () => ai.explainFormula(formula, columns), (result) => result.summary));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(null);
		}
	}

	async function repair() {
		if (!selected.formula) return;
		const formula = selected.formula;
		setRunning('fix');
		setError(null);
		try {
			setFix(await runAiActivity('formula-fix', null, () => ai.fixFormula(formula, errorCode, columns), (result) => result?.formula ?? 'No fix found'));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setRunning(null);
		}
	}

	function insert(formula: string) {
		onInsert(formula);
		setOpen(false);
		setPrompt('');
		setSuggestion(null);
		setFix(undefined);
	}

	function submitWrite(event: FormEvent) {
		event.preventDefault();
		void write();
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100"
					aria-label="Formula help from AI"
				>
					<Sparkles className="size-3" />
					AI
				</button>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="w-[26rem] max-w-[calc(100vw-2rem)]">
				<div className="grid gap-3 text-sm">
					<div className="flex items-center justify-between gap-2">
						<p className="font-medium">
							Formula help · {selected.columnName}, row {selected.rowNumber.toLocaleString()}
						</p>
						<MockAiBadge />
					</div>

					{canInsert && (
						<form className="grid gap-2" onSubmit={submitWrite}>
							<label htmlFor="formula-prompt" className="text-xs text-muted-foreground">
								Describe the formula you need
							</label>
							<div className="flex gap-2">
								<Input
									id="formula-prompt"
									value={prompt}
									onChange={(event) => setPrompt(event.target.value)}
									className="h-8 text-xs"
									placeholder="e.g. flag rows where Quantity is below Reorder Level"
								/>
								<Button type="submit" size="sm" disabled={!prompt.trim() || running !== null}>
									{running === 'write' ? 'Writing…' : 'Write'}
								</Button>
							</div>
						</form>
					)}

					{suggestion &&
						(suggestion.formula ? (
							<div className="grid gap-1.5 rounded-md bg-muted/60 p-2.5">
								<code className="font-mono text-xs break-all text-blue-700">{suggestion.formula}</code>
								<p className="text-xs text-muted-foreground">{suggestion.explanation}</p>
								{suggestion.warnings.map((warning) => (
									<p key={warning} className="text-xs text-amber-800">
										{warning}
									</p>
								))}
								<div className="flex gap-2 pt-1">
									<Button size="xs" onClick={() => insert(suggestion.formula)}>
										Insert into cell
									</Button>
									<span className="self-center text-[11px] text-muted-foreground">The grid shows the result; undo with Ctrl+Z.</span>
								</div>
							</div>
						) : (
							suggestion.warnings.map((warning) => (
								<p key={warning} className="text-xs text-amber-800">
									{warning}
								</p>
							))
						))}

					{selected.formula && (
						<div className="grid gap-2 border-t pt-3">
							<code className="font-mono text-xs break-all text-muted-foreground">{selected.formula}</code>
							<div className="flex gap-2">
								<Button size="xs" variant="outline" disabled={running !== null} onClick={explain}>
									{running === 'explain' ? 'Explaining…' : 'Explain'}
								</Button>
								{errorCode && canInsert && (
									<Button size="xs" variant="outline" disabled={running !== null} onClick={repair}>
										{running === 'fix' ? 'Fixing…' : `Fix ${errorCode}`}
									</Button>
								)}
							</div>
							{explanation && (
								<div className="grid gap-1 text-xs">
									<p>{explanation.summary}</p>
									<ul className="grid gap-0.5 pl-4 text-muted-foreground">
										{explanation.steps.map((step) => (
											<li key={step} className="list-disc">
												{step}
											</li>
										))}
									</ul>
								</div>
							)}
							{fix ? (
								<div className="grid gap-1.5 rounded-md bg-emerald-50/70 p-2.5">
									<code className="font-mono text-xs break-all text-emerald-800">{fix.formula}</code>
									<p className="text-xs text-muted-foreground">{fix.reason}</p>
									<div>
										<Button size="xs" onClick={() => insert(fix.formula)}>
											Use this formula
										</Button>
									</div>
								</div>
							) : (
								fix === null && <p className="text-xs text-muted-foreground">No automatic fix for {errorCode}. Try Explain to see what the formula reads.</p>
							)}
						</div>
					)}

					{error && <p className="text-xs text-red-600">{error}</p>}
				</div>
			</PopoverContent>
		</Popover>
	);
}
