import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { queryKeys } from '@/lib/queries/keys';
import { sheetRepository, type ColumnDeleteResult } from '@/lib/storage';
import type { Column } from '@/lib/types';
import { formatCount } from '@/lib/utils/format';

/** Ported from components/sheet-viewer/DeleteColumnDialog.svelte. */
export function DeleteColumnDialog({
	open,
	onOpenChange,
	sheetId,
	column,
	onDeleted
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheetId: string;
	column: Column | null;
	onDeleted: (result: ColumnDeleteResult) => void;
}) {
	// Count what will be lost each time the confirmation opens.
	const usage = useQuery({
		queryKey: queryKeys.columnUsage(sheetId, column?.key ?? ''),
		queryFn: () => sheetRepository.columnUsage(sheetId, column!.key),
		enabled: open && column !== null,
		staleTime: 0,
		gcTime: 0
	});

	const remove = useMutation({
		mutationFn: (target: Column) => sheetRepository.deleteColumn(sheetId, target.key),
		onSuccess: (result: ColumnDeleteResult) => {
			onOpenChange(false);
			onDeleted(result);
		}
	});

	useEffect(() => {
		if (open) remove.reset();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<TriangleAlert className="size-5 text-red-600" />
						Delete column “{column?.name}”?
					</AlertDialogTitle>
					<AlertDialogDescription>The column and all of its data will be permanently deleted from this sheet. This can't be undone.</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
					{usage.isPending ? (
						'Checking how much data this column holds…'
					) : usage.isError ? (
						"Could not count the column's data. Deleting still removes every value in it."
					) : usage.data ? (
						<ul className="flex list-disc flex-col gap-1 pl-4">
							<li>
								{usage.data.filledCells > 0 ? (
									<>
										<span className="font-semibold">{formatCount(usage.data.filledCells)}</span> {usage.data.filledCells === 1 ? 'cell with data' : 'cells with data'} will be deleted.
									</>
								) : (
									'The column is empty; no cell data will be lost.'
								)}
							</li>
							{usage.data.formulaReferences > 0 && (
								<li>
									<span className="font-semibold">{formatCount(usage.data.formulaReferences)}</span> {usage.data.formulaReferences === 1 ? 'formula references' : 'formulas reference'}{' '}
									<code className="font-mono text-xs">[{column?.name}]</code> and will show <code className="font-mono text-xs">#REF!</code>.
								</li>
							)}
						</ul>
					) : null}
				</div>

				{remove.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{remove.error instanceof Error ? remove.error.message : String(remove.error)}</p>}

				<AlertDialogFooter>
					<AlertDialogCancel disabled={remove.isPending}>Keep column</AlertDialogCancel>
					<AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" disabled={remove.isPending || usage.isPending || !column} onClick={() => column && remove.mutate(column)}>
						{remove.isPending ? 'Deleting…' : 'Delete column and data'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
