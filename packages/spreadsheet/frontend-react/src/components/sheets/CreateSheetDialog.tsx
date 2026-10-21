import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { MockAiBadge } from '@/components/ai/MockAiBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ai } from '@/lib/ai/provider';
import { draftsToOptions, optionDraft, optionDraftsFrom, suggestedOptionDrafts, type OptionDraft } from '@/lib/editing/column-drafts';
import { queryKeys } from '@/lib/queries/keys';
import { sheetRepository, type CreateSheetInput, type NewColumnInput } from '@/lib/storage';
import { isCreatableType, validateCreateSheetInput } from '@/lib/storage/sheet-schema';
import { useAiActivityStore } from '@/stores/ai-activity';
import { usePreferencesStore } from '@/stores/preferences';
import type { ColumnSettings, KnownColumnType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ColumnTypeSelect } from './ColumnTypeSelect';
import { EnumOptionsEditor } from './EnumOptionsEditor';

interface ColumnDraft {
	id: number;
	name: string;
	type: KnownColumnType;
	options: OptionDraft[];
	/** Extra settings from an AI draft: column formula, format, currency, group. */
	settings: ColumnSettings;
	defaultInput?: string;
}

let nextId = 0;
const columnDraft = (values: Partial<ColumnDraft>): ColumnDraft => ({
	id: nextId++,
	name: '',
	type: 'text',
	options: [],
	settings: {},
	...values
});
const defaultColumns = (): ColumnDraft[] => [
	columnDraft({ name: 'Name' }),
	columnDraft({
		name: 'Status',
		type: 'enum',
		options: [optionDraft('Not Started', 'slate'), optionDraft('In Progress', 'blue'), optionDraft('Complete', 'green')]
	}),
	columnDraft({ name: 'Due Date', type: 'date' })
];

const toColumnInput = (column: ColumnDraft): NewColumnInput => ({
	name: column.name,
	data_type: column.type,
	settings: { ...column.settings, ...(column.type === 'enum' ? { options: draftsToOptions(column.options) } : {}) },
	...(column.defaultInput ? { defaultInput: column.defaultInput } : {})
});

/**
 * Ported from components/sheets/CreateSheetDialog.svelte. `bind:open` becomes
 * a controlled `open`/`onOpenChange` pair (the parent owns the boolean, same
 * as the Svelte version's caller did via `bind:open={createOpen}`).
 */
export function CreateSheetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const runAiActivity = useAiActivityStore((state) => state.run);
	const sheetSource = usePreferencesStore((state) => state.sheetSource);
	const setSheetSource = usePreferencesStore((state) => state.setSheetSource);

	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [columns, setColumns] = useState<ColumnDraft[]>(defaultColumns);
	const [submitted, setSubmitted] = useState(false);

	// -- Describe-a-sheet ----------------------------------------------------------------

	const [prompt, setPrompt] = useState('');
	const [drafting, setDrafting] = useState(false);
	const [draftNotes, setDraftNotes] = useState<string[]>([]);
	const [draftError, setDraftError] = useState<string | null>(null);

	async function draftFromPrompt() {
		const text = prompt.trim();
		if (!text || drafting) return;
		setDrafting(true);
		setDraftError(null);
		try {
			const draft = await runAiActivity('describe-sheet', null, () => ai.describeSheet(text), (result) => `${result.name}: ${result.columns.length} columns`);
			setName(draft.name);
			setDescription(draft.description);
			setColumns(
				draft.columns.map((input) =>
					columnDraft({
						name: input.name,
						type: isCreatableType(input.data_type) ? input.data_type : 'text',
						options: input.data_type === 'enum' ? optionDraftsFrom(input.settings?.options ?? []) : [],
						settings: { ...(input.settings ?? {}) },
						defaultInput: input.defaultInput ?? undefined
					})
				)
			);
			setDraftNotes(draft.notes);
		} catch (error) {
			setDraftError(error instanceof Error ? error.message : String(error));
		} finally {
			setDrafting(false);
		}
	}

	const input: CreateSheetInput = { name, description, columns: columns.map(toColumnInput) };
	const validation = validateCreateSheetInput(input);
	const errors = submitted && !validation.ok ? validation.errors : null;

	const create = useMutation({
		// Creates wherever the sidebar's source toggle currently points, so an "ICP" pick
		// actually lands on the canister; anything else (including the read-only "Server")
		// falls back to local, which is always writable.
		mutationFn: (value: CreateSheetInput) => sheetRepository.createSheet(value, sheetSource === 'icp' ? 'icp' : 'local'),
		onSuccess: async (sheet) => {
			setSheetSource(sheet.source === 'icp' ? 'icp' : 'local');
			await queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
			onOpenChange(false);
			navigate(`/sheets/${sheet.id}`);
		}
	});

	function reset() {
		setName('');
		setDescription('');
		setColumns(defaultColumns());
		setSubmitted(false);
		setPrompt('');
		setDraftNotes([]);
		setDraftError(null);
		create.reset();
	}

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
		if (!next) reset();
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		if (validation.ok) create.mutate(validation.value);
	}

	function move(index: number, delta: number) {
		const target = index + delta;
		if (target < 0 || target >= columns.length) return;
		const next = [...columns];
		[next[index], next[target]] = [next[target], next[index]];
		setColumns(next);
	}

	function updateColumn(id: number, patch: Partial<ColumnDraft>) {
		setColumns((current) => current.map((column) => (column.id === id ? { ...column, ...patch } : column)));
	}

	function setType(column: ColumnDraft, type: KnownColumnType) {
		updateColumn(column.id, {
			type,
			options: type === 'enum' && column.options.length === 0 ? suggestedOptionDrafts([]) : column.options
		});
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<form onSubmit={submit} className="flex flex-col gap-5" noValidate>
					<DialogHeader>
						<DialogTitle>New sheet</DialogTitle>
						<DialogDescription>
							Define the columns now, then add rows, values and formulas in the grid. Formulas go in any cell, starting
							with <code className="font-mono text-xs">=</code>. You can rename columns or change their types later. The
							sheet is saved in this browser.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor="sheet-prompt" className="flex items-center gap-1.5">
								<Sparkles className="size-4 text-violet-600" />
								Describe it
							</Label>
							<MockAiBadge />
						</div>
						<Textarea
							id="sheet-prompt"
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							rows={2}
							placeholder="e.g. Track supplier invoices: amount, due date, whether it’s paid"
							onKeyDown={(event) => {
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									void draftFromPrompt();
								}
							}}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" size="sm" variant="outline" disabled={!prompt.trim() || drafting} onClick={draftFromPrompt}>
								{drafting ? 'Drafting…' : 'Draft columns'}
							</Button>
							<span className="text-xs text-muted-foreground">
								Fills in the name, description and columns below. Nothing is created until you click Create sheet.
							</span>
						</div>
						{draftError && <p className="text-xs text-red-600">{draftError}</p>}
						{draftNotes.length > 0 && (
							<ul className="grid gap-0.5 pl-4 text-xs text-muted-foreground">
								{draftNotes.map((note) => (
									<li key={note} className="list-disc">
										{note}
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="grid gap-2">
						<Label htmlFor="sheet-name">Name</Label>
						<Input id="sheet-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Q4 Budget" aria-invalid={!!errors?.name} />
						{errors?.name && <p className="text-xs text-red-600">{errors.name}</p>}
					</div>

					<div className="grid gap-2">
						<Label htmlFor="sheet-description">
							Description <span className="font-normal text-muted-foreground">(optional)</span>
						</Label>
						<Textarea id="sheet-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder="What is this sheet for?" />
						{errors?.description && <p className="text-xs text-red-600">{errors.description}</p>}
					</div>

					<div className="grid gap-2">
						<div className="flex items-baseline justify-between gap-4">
							<Label>Columns</Label>
							<span className="text-xs text-muted-foreground">The first column is the primary column.</span>
						</div>

						<div className="flex flex-col gap-2">
							{columns.map((column, index) => (
								<div key={column.id} className={cn('rounded-lg border p-2.5', errors?.columnErrors[index] && 'border-red-300 bg-red-50/40')}>
									<div className="flex items-center gap-2">
										<Input
											value={column.name}
											onChange={(event) => updateColumn(column.id, { name: event.target.value })}
											placeholder="Column name"
											className="h-8 flex-1"
											aria-label={`Column ${index + 1} name`}
											aria-invalid={!!errors?.columnErrors[index]}
										/>
										<ColumnTypeSelect value={column.type} onChange={(type) => setType(column, type)} ariaLabel={`Column ${index + 1} type`} />
										<Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move column up">
											<ArrowUp className="size-4" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8"
											disabled={index === columns.length - 1}
											onClick={() => move(index, 1)}
											aria-label="Move column down"
										>
											<ArrowDown className="size-4" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8 text-muted-foreground hover:text-red-700"
											disabled={columns.length === 1}
											onClick={() => setColumns((current) => current.filter((candidate) => candidate.id !== column.id))}
											aria-label="Remove column"
										>
											<Trash2 className="size-4" />
										</Button>
									</div>

									{column.type === 'enum' && (
										<div className="mt-2">
											<EnumOptionsEditor options={column.options} onChange={(options) => updateColumn(column.id, { options })} label={`Column ${index + 1}`} />
										</div>
									)}

									{(column.settings.column_formula || column.settings.column_group || column.defaultInput) && (
										<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
											{column.settings.column_formula && (
												<span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-blue-700" title="Column formula: every row is calculated">
													ƒ {column.settings.column_formula}
												</span>
											)}
											{column.settings.column_group && <span className="rounded bg-muted px-1.5 py-0.5">Group: {column.settings.column_group}</span>}
											{column.defaultInput && <span className="rounded bg-muted px-1.5 py-0.5">Default: {column.defaultInput}</span>}
											<button
												type="button"
												className="text-muted-foreground underline-offset-2 hover:underline"
												onClick={() => updateColumn(column.id, { settings: {}, defaultInput: undefined })}
											>
												Remove
											</button>
										</div>
									)}

									{errors?.columnErrors[index] && <p className="mt-1.5 text-xs text-red-600">{errors.columnErrors[index]}</p>}
								</div>
							))}
						</div>

						{errors?.columns && <p className="text-xs text-red-600">{errors.columns}</p>}

						<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setColumns((current) => [...current, columnDraft({})])}>
							<Plus className="size-4" />
							Add column
						</Button>
					</div>

					{create.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{create.error instanceof Error ? create.error.message : String(create.error)}</p>}

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={create.isPending}>
							{create.isPending ? 'Creating…' : 'Create sheet'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
