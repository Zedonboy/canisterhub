import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ColumnTypeSelect } from '@/components/sheets/ColumnTypeSelect';
import { EnumOptionsEditor } from '@/components/sheets/EnumOptionsEditor';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cellInputText } from '@/lib/editing/cell-input';
import { draftsToOptions, optionDraftsFrom, suggestedOptionDrafts, type OptionDraft } from '@/lib/editing/column-drafts';
import { queryKeys } from '@/lib/queries/keys';
import { sheetRepository, type ColumnUpdateInput, type ColumnUpdateResult } from '@/lib/storage';
import { columnTypeLabel, isCreatableType, validateColumnUpdate } from '@/lib/storage/sheet-schema';
import type { Column, KnownColumnType } from '@/lib/types';
import { ColumnValueSettings } from './ColumnValueSettings';

interface SaveVariables {
	column: Column;
	value: ColumnUpdateInput;
}

/** Ported from components/sheet-viewer/EditColumnDialog.svelte. */
export function EditColumnDialog({
	open,
	onOpenChange,
	sheetId,
	column,
	columns,
	suggestedOptions,
	onSaved,
	canDelete,
	onRequestDelete
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheetId: string;
	column: Column | null;
	/** All columns of the sheet, for name uniqueness. */
	columns: Column[];
	/** Distinct existing values of the column, used to pre-fill enum options. */
	suggestedOptions: () => string[];
	onSaved: (result: ColumnUpdateResult, previous: Column) => void;
	/** False for a sheet's last column. */
	canDelete: boolean;
	onRequestDelete: (column: Column) => void;
}) {
	const [name, setName] = useState('');
	const [type, setTypeState] = useState<KnownColumnType>('text');
	const [options, setOptions] = useState<OptionDraft[]>([]);
	const [defaultInput, setDefaultInput] = useState('');
	const [formulaEnabled, setFormulaEnabled] = useState(false);
	const [formula, setFormula] = useState('');
	const [submitted, setSubmitted] = useState(false);

	const save = useMutation({
		mutationFn: (input: SaveVariables) => sheetRepository.updateColumn(sheetId, input.column.key, input.value),
		onSuccess: (result: ColumnUpdateResult, input: SaveVariables) => {
			onOpenChange(false);
			onSaved(result, input.column);
		}
	});

	// Load the column into the form each time the dialog opens.
	useEffect(() => {
		if (!open || !column) return;
		setName(column.name);
		setTypeState(isCreatableType(column.data_type) ? column.data_type : 'text');
		setOptions(column.data_type === 'enum' ? optionDraftsFrom(column.settings.options ?? []) : []);
		setDefaultInput(cellInputText(column.settings.default_value));
		setFormulaEnabled(!!column.settings.column_formula);
		setFormula(column.settings.column_formula ?? '');
		setSubmitted(false);
		save.reset();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, column]);

	function setType(next: KnownColumnType) {
		setTypeState(next);
		if (next === 'enum' && options.length === 0) setOptions(suggestedOptionDrafts(suggestedOptions()));
	}

	const input: ColumnUpdateInput = {
		name,
		data_type: type,
		settings: {
			...(type === 'enum' ? { options: draftsToOptions(options) } : {}),
			column_formula: formulaEnabled ? formula : ''
		},
		defaultInput: formulaEnabled ? '' : defaultInput
	};

	/** True when saving would (re)write every cell with the column formula. */
	const formulaApplying =
		!!column && formulaEnabled && formula.trim() !== '' && (formula.trim() !== (column.settings.column_formula ?? '') || type !== column.data_type);

	// How many filled cells the column formula would replace.
	const usage = useQuery({
		queryKey: queryKeys.columnUsage(sheetId, column?.key ?? ''),
		queryFn: () => sheetRepository.columnUsage(sheetId, column!.key),
		enabled: open && formulaApplying,
		staleTime: 0
	});
	const validation = column ? validateColumnUpdate(columns, column.key, input) : null;
	const error = submitted && validation && !validation.ok ? validation.error : null;

	const renamed = !!column && name.trim() !== '' && name.trim() !== column.name;
	const typeChanged = !!column && type !== column.data_type;

	function submit(event: FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		if (column && validation?.ok) save.mutate({ column, value: validation.value });
	}

	const overwriteNote = formulaApplying ? (
		<p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
			{usage.data && usage.data.filledCells > 0 ? (
				<>
					<span className="font-semibold">{usage.data.filledCells}</span> {usage.data.filledCells === 1 ? 'cell' : 'cells'} with data will be replaced by the formula.
				</>
			) : usage.data ? (
				'The column is empty; every row will use the formula.'
			) : (
				'Existing values in this column will be replaced by the formula.'
			)}
		</p>
	) : null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5" noValidate>
					<DialogHeader>
						<DialogTitle>Edit column</DialogTitle>
						<DialogDescription>Rename the column or change its type.</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2">
						<Label htmlFor="column-name">Name</Label>
						<Input id="column-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Column name" aria-invalid={!!error} />
					</div>

					<div className="grid gap-2">
						<Label>Type</Label>
						<ColumnTypeSelect value={type} onChange={setType} className="w-full" />
						{type === 'enum' && (
							<div className="mt-1">
								<EnumOptionsEditor options={options} onChange={setOptions} label="Column" />
							</div>
						)}
					</div>

					<ColumnValueSettings
						type={type}
						idPrefix="edit-column"
						defaultInput={defaultInput}
						onDefaultInputChange={setDefaultInput}
						formulaEnabled={formulaEnabled}
						onFormulaEnabledChange={setFormulaEnabled}
						formula={formula}
						onFormulaChange={setFormula}
						defaultHint="Filled into new rows; existing cells keep their values. A value, or a formula starting with =."
						formulaNote={overwriteNote}
					/>

					{(renamed || typeChanged) && (
						<div className="flex flex-col gap-1.5 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900">
							{renamed && (
								<p>
									Formulas that reference <code className="font-mono">[{column?.name}]</code> will be updated to <code className="font-mono">[{name.trim()}]</code>.
								</p>
							)}
							{typeChanged && column && (
								<p>
									Existing values will be converted from {columnTypeLabel(column.data_type)} to {columnTypeLabel(type)}. Values that can't be converted are cleared; formulas are kept.
								</p>
							)}
						</div>
					)}

					{error && <p className="text-xs text-red-600">{error}</p>}
					{save.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{save.error instanceof Error ? save.error.message : String(save.error)}</p>}

					<DialogFooter className="sm:justify-between">
						<Button
							type="button"
							variant="ghost"
							className="text-red-700 hover:bg-red-50 hover:text-red-800"
							disabled={!canDelete || !column}
							title={canDelete ? undefined : 'A sheet needs at least one column'}
							onClick={() => {
								if (!column) return;
								onOpenChange(false);
								onRequestDelete(column);
							}}
						>
							<Trash2 className="size-4" />
							Delete column
						</Button>
						<div className="flex flex-col-reverse gap-2 sm:flex-row">
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={save.isPending}>
								{save.isPending ? 'Saving…' : 'Save column'}
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
