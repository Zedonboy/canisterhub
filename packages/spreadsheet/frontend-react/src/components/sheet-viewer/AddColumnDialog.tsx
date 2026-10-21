import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ColumnTypeSelect } from '@/components/sheets/ColumnTypeSelect';
import { EnumOptionsEditor } from '@/components/sheets/EnumOptionsEditor';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { draftsToOptions, suggestedOptionDrafts, type OptionDraft } from '@/lib/editing/column-drafts';
import { sheetRepository, type AddColumnInput } from '@/lib/storage';
import { validateNewColumn } from '@/lib/storage/sheet-schema';
import type { Column, KnownColumnType } from '@/lib/types';
import { ColumnValueSettings } from './ColumnValueSettings';

const END = '__end__';

/** Ported from components/sheet-viewer/AddColumnDialog.svelte. */
export function AddColumnDialog({
	open,
	onOpenChange,
	sheetId,
	columns,
	initialAfterColumnKey,
	onAdded
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheetId: string;
	columns: Column[];
	/** Position preselected when the dialog opens (e.g. "Insert column right"). */
	initialAfterColumnKey?: string;
	onAdded: (column: Column) => void;
}) {
	const [name, setName] = useState('');
	const [type, setTypeState] = useState<KnownColumnType>('text');
	const [options, setOptions] = useState<OptionDraft[]>([]);
	const [position, setPosition] = useState(END);
	const [defaultInput, setDefaultInput] = useState('');
	const [formulaEnabled, setFormulaEnabled] = useState(false);
	const [formula, setFormula] = useState('');
	const [submitted, setSubmitted] = useState(false);

	const add = useMutation({
		mutationFn: (input: AddColumnInput) => sheetRepository.addColumn(sheetId, input),
		onSuccess: (column: Column) => {
			onOpenChange(false);
			onAdded(column);
		}
	});

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setName('');
		setTypeState('text');
		setOptions([]);
		setPosition(initialAfterColumnKey ?? END);
		setDefaultInput('');
		setFormulaEnabled(false);
		setFormula('');
		setSubmitted(false);
		add.reset();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	function setType(next: KnownColumnType) {
		setTypeState(next);
		if (next === 'enum' && options.length === 0) setOptions(suggestedOptionDrafts([]));
	}

	const input: AddColumnInput = {
		name,
		data_type: type,
		settings: {
			...(type === 'enum' ? { options: draftsToOptions(options) } : {}),
			column_formula: formulaEnabled ? formula : ''
		},
		defaultInput: formulaEnabled ? '' : defaultInput,
		afterColumnKey: position === END ? undefined : position
	};
	const validation = validateNewColumn(columns, input);
	const error = submitted && !validation.ok ? validation.error : null;
	const positionLabel = position === END ? 'At the end' : `After “${columns.find((column) => column.key === position)?.name ?? ''}”`;

	function submit(event: FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		if (validation.ok) add.mutate({ ...validation.value, afterColumnKey: input.afterColumnKey });
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5" noValidate>
					<DialogHeader>
						<DialogTitle>Add column</DialogTitle>
						<DialogDescription>The new column starts empty in every row.</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2">
						<Label htmlFor="new-column-name">Name</Label>
						<Input id="new-column-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Column name" aria-invalid={!!error} />
					</div>

					<div className="grid gap-2">
						<Label>Type</Label>
						<ColumnTypeSelect value={type} onChange={setType} className="w-full" />
						{type === 'enum' && (
							<div className="mt-1">
								<EnumOptionsEditor options={options} onChange={setOptions} label="New column" />
							</div>
						)}
					</div>

					<ColumnValueSettings
						type={type}
						idPrefix="new-column"
						defaultInput={defaultInput}
						onDefaultInputChange={setDefaultInput}
						formulaEnabled={formulaEnabled}
						onFormulaEnabledChange={setFormulaEnabled}
						formula={formula}
						onFormulaChange={setFormula}
						defaultHint="Filled into every existing row and each new row. A value, or a formula starting with =."
					/>

					<div className="grid gap-2">
						<Label>Position</Label>
						<Select value={position} onValueChange={setPosition}>
							<SelectTrigger className="h-8 w-full" aria-label="Column position">
								{positionLabel}
							</SelectTrigger>
							<SelectContent className="max-h-72">
								<SelectItem value={END}>At the end</SelectItem>
								{columns.map((column) => (
									<SelectItem key={column.key} value={column.key}>
										After “{column.name}”
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{error && <p className="text-xs text-red-600">{error}</p>}
					{add.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{add.error instanceof Error ? add.error.message : String(add.error)}</p>}

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={add.isPending}>
							{add.isPending ? 'Adding…' : 'Add column'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
