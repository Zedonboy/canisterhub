import { ChartPie, ClipboardList, Columns3, Ellipsis, FileText, Group, Plus, Rows3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { DENSITY_OPTIONS, usePreferencesStore, type GridDensity } from '@/stores/preferences';

const destructive = 'text-red-700 data-highlighted:bg-red-50 data-highlighted:text-red-800 [&_svg]:text-red-600';

/** Ported from components/sheet-viewer/SheetActionsMenu.svelte. */
export function SheetActionsMenu({
	editable,
	selectedRowCount,
	groupableColumnCount,
	onAddRow,
	onAddColumn,
	onDeleteRows,
	onGroupColumns,
	onImportDocument,
	onDeleteSheet,
	onCreateChart,
	onCreateForm
}: {
	/** Editing actions are only offered for writable sheets. */
	editable: boolean;
	selectedRowCount: number;
	/** Selected columns that sit next to each other, so they could share a group header. */
	groupableColumnCount: number;
	onAddRow: () => void;
	onAddColumn: () => void;
	onDeleteRows: () => void;
	onGroupColumns: () => void;
	/** Opens the AI document import. */
	onImportDocument: () => void;
	/** Opens the delete-sheet confirmation. */
	onDeleteSheet: () => void;
	/** Creates a chart from this sheet and opens it. */
	onCreateChart: () => void;
	/** Creates a data entry form for this sheet and opens its editor (writable sheets). */
	onCreateForm: () => void;
}) {
	const density = usePreferencesStore((state) => state.density);
	const setDensity = usePreferencesStore((state) => state.setDensity);
	const densityLabel = DENSITY_OPTIONS.find((option) => option.value === density)?.label;
	const deleteRowsLabel = selectedRowCount > 0 ? `Delete ${selectedRowCount} ${selectedRowCount === 1 ? 'row' : 'rows'}` : 'Delete selected rows';

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="h-8" aria-label="Sheet actions">
					<Ellipsis className="size-4" />
					<span className="hidden sm:inline">Actions</span>
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="end" className="w-56">
				{editable && (
					<>
						<DropdownMenuGroup>
							<DropdownMenuItem onSelect={onAddRow}>
								<Plus className="size-4" />
								Add row
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={onAddColumn}>
								<Columns3 className="size-4" />
								Add column
							</DropdownMenuItem>
							<DropdownMenuItem disabled={groupableColumnCount < 2} onSelect={onGroupColumns}>
								<Group className="size-4" />
								{groupableColumnCount > 0 ? `Group ${groupableColumnCount} columns` : 'Group selected columns'}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={onImportDocument}>
								<FileText className="size-4 text-violet-600" />
								Import from document…
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
					</>
				)}

				<DropdownMenuGroup>
					<DropdownMenuItem onSelect={onCreateChart}>
						<ChartPie className="size-4" />
						Create chart…
					</DropdownMenuItem>
					{editable && (
						<DropdownMenuItem onSelect={onCreateForm}>
							<ClipboardList className="size-4" />
							Create form…
						</DropdownMenuItem>
					)}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />

				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<Rows3 className="size-4" />
						Density
						<span className="ml-auto text-xs text-muted-foreground">{densityLabel}</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-44">
						<DropdownMenuRadioGroup value={density} onValueChange={(value) => setDensity(value as GridDensity)}>
							{DENSITY_OPTIONS.map((option) => (
								<DropdownMenuRadioItem key={option.value} value={option.value}>
									{option.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>

				{editable && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem className={destructive} disabled={selectedRowCount === 0} onSelect={onDeleteRows}>
							<Trash2 className="size-4" />
							{deleteRowsLabel}
						</DropdownMenuItem>
						<DropdownMenuItem className={destructive} onSelect={onDeleteSheet}>
							<Trash2 className="size-4" />
							Delete sheet…
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
