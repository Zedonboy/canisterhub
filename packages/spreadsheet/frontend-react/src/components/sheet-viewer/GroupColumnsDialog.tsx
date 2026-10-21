import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sheetRepository } from '@/lib/storage';
import { validateColumnGroupName } from '@/lib/storage/sheet-schema';
import type { Column } from '@/lib/types';

/** Ported from components/sheet-viewer/GroupColumnsDialog.svelte. */
export function GroupColumnsDialog({
	open,
	onOpenChange,
	sheetId,
	mode,
	columnKeys = [],
	groupName,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheetId: string;
	mode: 'group' | 'rename';
	/** mode 'group': the columns to group under the new name. */
	columnKeys?: string[];
	/** mode 'rename': the existing group name being renamed. */
	groupName?: string;
	onSaved: (columns: Column[]) => void;
}) {
	const [name, setName] = useState('');
	const [submitted, setSubmitted] = useState(false);

	const save = useMutation({
		mutationFn: () => (mode === 'group' ? sheetRepository.groupColumns(sheetId, columnKeys, name) : sheetRepository.renameColumnGroup(sheetId, groupName!, name)),
		onSuccess: (columns: Column[]) => {
			onOpenChange(false);
			onSaved(columns);
		}
	});

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setName(mode === 'rename' ? (groupName ?? '') : '');
		setSubmitted(false);
		save.reset();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const validation = validateColumnGroupName(name);
	const error = submitted && validation.error ? validation.error : null;

	function submit(event: FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		if (!validation.error) save.mutate();
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={submit} className="flex flex-col gap-5" noValidate>
					<DialogHeader>
						<DialogTitle>{mode === 'group' ? 'Group columns' : 'Rename group'}</DialogTitle>
						<DialogDescription>{mode === 'group' ? `${columnKeys.length} columns will share one header.` : `Every column in “${groupName}” moves to the new name.`}</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2">
						<Label htmlFor="group-name">Group name</Label>
						<Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Q1 Sales" aria-invalid={!!error} autoFocus />
					</div>

					{error && <p className="text-xs text-red-600">{error}</p>}
					{save.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{save.error instanceof Error ? save.error.message : String(save.error)}</p>}

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? 'Saving…' : mode === 'group' ? 'Group columns' : 'Rename group'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
