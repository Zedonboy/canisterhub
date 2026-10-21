import {
	ArrowDownToLine,
	ArrowLeftToLine,
	ArrowRightToLine,
	ArrowUpToLine,
	ClipboardPaste,
	Copy,
	Eraser,
	Group,
	ListIndentDecrease,
	ListIndentIncrease,
	ListTree,
	Settings2,
	Shapes,
	Sparkles,
	Trash2,
	Ungroup,
	WandSparkles
} from 'lucide-react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { ColumnGroupMenuState, GridContextMenuTarget } from '@/lib/grid/sheet-grid-controller';
import { COLUMN_TYPE_GROUPS, columnTypeLabel } from '@/lib/storage/sheet-schema';
import type { Column, KnownColumnType, RowData } from '@/lib/types';

type CellTarget = Extract<GridContextMenuTarget, { kind: 'cell' }>;

const destructive = 'text-red-700 data-highlighted:bg-red-50 data-highlighted:text-red-800 [&_svg]:text-red-600';

/**
 * Ported from components/sheet-viewer/GridContextMenu.svelte. The Svelte
 * original passed `preventScroll={false}` to bits-ui's `DropdownMenu.Content`
 * so a second right-click could still reach the grid (no pointer-events:none
 * body lock while open); Radix's equivalent is `modal={false}` on the Root,
 * not a Content prop.
 */
export function GridContextMenu({
	open,
	onOpenChange,
	target,
	column,
	row,
	rowNumber,
	editable,
	collapsed,
	rowsToDelete,
	levelRows,
	canIndent,
	canOutdent,
	canDeleteColumn,
	groupMenu,
	onClose,
	onRestoreFocus,
	onCopy,
	onPaste,
	onClear,
	onToggleRow,
	onInsertRow,
	onDeleteRows,
	onIndent,
	onOutdent,
	onEditColumn,
	onChangeColumnType,
	onInsertColumn,
	onDeleteColumn,
	onGroupColumns,
	onRenameGroup,
	onUngroupColumns,
	onCleanColumn,
	onFillColumn
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: GridContextMenuTarget | null;
	column: Column | undefined;
	row: RowData | undefined;
	rowNumber: number | undefined;
	/** Editing actions are only shown for writable sheets. */
	editable: boolean;
	collapsed: boolean;
	rowsToDelete: number;
	/** Rows that Indent/Outdent act on, and whether either applies to them. */
	levelRows: number;
	canIndent: boolean;
	canOutdent: boolean;
	canDeleteColumn: boolean;
	groupMenu: ColumnGroupMenuState;
	onClose: () => void;
	/** Called after the menu closes so keyboard focus can return to the grid. */
	onRestoreFocus: () => void;
	onCopy: (target: CellTarget) => void;
	onPaste: (target: CellTarget) => void;
	onClear: (target: CellTarget) => void;
	onToggleRow: (target: CellTarget) => void;
	onInsertRow: (target: CellTarget, where: 'above' | 'below') => void;
	onDeleteRows: (target: CellTarget) => void;
	onIndent: (target: CellTarget) => void;
	onOutdent: (target: CellTarget) => void;
	onEditColumn: (column: Column) => void;
	/** Converts the column (and so every cell in it) to another value type. */
	onChangeColumnType: (column: Column, type: KnownColumnType) => void;
	onInsertColumn: (column: Column, side: 'left' | 'right') => void;
	onDeleteColumn: (column: Column) => void;
	onGroupColumns: (keys: string[]) => void;
	onRenameGroup: (groupName: string) => void;
	onUngroupColumns: (keys: string[]) => void;
	onCleanColumn: (column: Column) => void;
	onFillColumn: (column: Column) => void;
}) {
	const cell = target?.kind === 'cell' ? target : null;
	/** Cells of a column formula are calculated and can't be pasted into or cleared. */
	const locked = !!column?.settings.column_formula;
	const rowsLabel = levelRows > 1 ? ` ${levelRows} rows` : ' row';
	const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

	return (
		<DropdownMenu
			modal={false}
			open={open}
			onOpenChange={(isOpen) => {
				onOpenChange(isOpen);
				if (!isOpen) onClose();
			}}
		>
			{/* Invisible anchor placed at the pointer; the menu is opened programmatically. */}
			<DropdownMenuTrigger asChild>
				<span aria-hidden="true" tabIndex={-1} className="pointer-events-none fixed size-0" style={{ left: target?.x ?? 0, top: target?.y ?? 0 }} />
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="start"
				sideOffset={2}
				className="w-60"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					onRestoreFocus();
				}}
			>
				{cell && (
					<>
						<DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
							{column?.name ?? 'Cell'}
							{rowNumber ? ` · row ${rowNumber}` : ''}
						</DropdownMenuLabel>

						<DropdownMenuItem onSelect={() => onCopy(cell)}>
							<Copy className="size-4" />
							Copy
							<DropdownMenuShortcut>{mod}C</DropdownMenuShortcut>
						</DropdownMenuItem>

						{editable && (
							<>
								<DropdownMenuItem disabled={locked} onSelect={() => onPaste(cell)}>
									<ClipboardPaste className="size-4" />
									Paste
									<DropdownMenuShortcut>{mod}V</DropdownMenuShortcut>
								</DropdownMenuItem>
								<DropdownMenuItem disabled={locked} onSelect={() => onClear(cell)}>
									<Eraser className="size-4" />
									Clear contents
									<DropdownMenuShortcut>Del</DropdownMenuShortcut>
								</DropdownMenuItem>
								{locked && <p className="px-2 pb-1 text-[11px] text-muted-foreground">Calculated by a column formula</p>}

								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => onInsertRow(cell, 'above')}>
									<ArrowUpToLine className="size-4" />
									Insert row above
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => onInsertRow(cell, 'below')}>
									<ArrowDownToLine className="size-4" />
									Insert row below
								</DropdownMenuItem>
								<DropdownMenuItem className={destructive} onSelect={() => onDeleteRows(cell)}>
									<Trash2 className="size-4" />
									{rowsToDelete > 1 ? `Delete ${rowsToDelete} rows` : 'Delete row'}
								</DropdownMenuItem>
							</>
						)}

						{(row?.has_children || editable) && (
							<>
								<DropdownMenuSeparator />
								{row?.has_children && (
									<DropdownMenuItem onSelect={() => onToggleRow(cell)}>
										<ListTree className="size-4" />
										{collapsed ? 'Expand row' : 'Collapse row'}
									</DropdownMenuItem>
								)}
								{editable && (
									<>
										<DropdownMenuItem disabled={!canIndent} onSelect={() => onIndent(cell)}>
											<ListIndentIncrease className="size-4" />
											Indent{rowsLabel}
											<DropdownMenuShortcut>{mod}]</DropdownMenuShortcut>
										</DropdownMenuItem>
										<DropdownMenuItem disabled={!canOutdent} onSelect={() => onOutdent(cell)}>
											<ListIndentDecrease className="size-4" />
											Outdent{rowsLabel}
											<DropdownMenuShortcut>{mod}[</DropdownMenuShortcut>
										</DropdownMenuItem>
									</>
								)}
							</>
						)}
					</>
				)}

				{editable && column && (
					<>
						{cell && <DropdownMenuSeparator />}
						<DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">Column “{column.name}”</DropdownMenuLabel>
						<DropdownMenuItem onSelect={() => onEditColumn(column)}>
							<Settings2 className="size-4" />
							Edit column…
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Shapes className="size-4" />
								<span className="flex-1">Change type</span>
								<span className="text-xs text-muted-foreground">{columnTypeLabel(column.data_type)}</span>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-60 overflow-y-auto">
								<p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
									Applies to every cell in “{column.name}”. Values that don’t fit are cleared; undo with {mod}Z.
								</p>
								{COLUMN_TYPE_GROUPS.map((group, index) => (
									<div key={group.label}>
										{index > 0 && <DropdownMenuSeparator />}
										<DropdownMenuRadioGroup value={column.data_type} onValueChange={(type) => onChangeColumnType(column, type as KnownColumnType)}>
											<DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{group.label}</DropdownMenuLabel>
											{group.types.map((type) => (
												<DropdownMenuRadioItem key={type.value} value={type.value}>
													{type.label}
													<span className="ml-auto text-[11px] text-muted-foreground">{type.hint}</span>
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuRadioGroup>
									</div>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem disabled={!!column.settings.primary} onSelect={() => onInsertColumn(column, 'left')}>
							<ArrowLeftToLine className="size-4" />
							Insert column left
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => onInsertColumn(column, 'right')}>
							<ArrowRightToLine className="size-4" />
							Insert column right
						</DropdownMenuItem>

						{!column.settings.column_formula && column.data_type !== 'protected' && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => onCleanColumn(column)}>
									<WandSparkles className="size-4 text-violet-600" />
									Clean up column…
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => onFillColumn(column)}>
									<Sparkles className="size-4 text-violet-600" />
									Fill with AI…
								</DropdownMenuItem>
							</>
						)}

						{groupMenu.kind !== 'none' && (
							<>
								<DropdownMenuSeparator />
								{groupMenu.kind === 'create' ? (
									<DropdownMenuItem onSelect={() => onGroupColumns(groupMenu.keys)}>
										<Group className="size-4" />
										Group {groupMenu.keys.length} columns…
									</DropdownMenuItem>
								) : groupMenu.kind === 'create-disabled' ? (
									<>
										<DropdownMenuItem disabled>
											<Group className="size-4" />
											Group {groupMenu.count} columns…
										</DropdownMenuItem>
										<p className="px-2 pb-1 text-[11px] text-muted-foreground">Select adjacent columns to group them</p>
									</>
								) : (
									<>
										<DropdownMenuItem onSelect={() => onRenameGroup(groupMenu.groupName)}>
											<Group className="size-4" />
											Rename group “{groupMenu.groupName}”…
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => onUngroupColumns(groupMenu.keys)}>
											<Ungroup className="size-4" />
											{groupMenu.keys.length > 1 ? `Ungroup ${groupMenu.keys.length} columns` : 'Remove from group'}
										</DropdownMenuItem>
									</>
								)}
							</>
						)}

						<DropdownMenuSeparator />
						<DropdownMenuItem className={destructive} disabled={!canDeleteColumn} onSelect={() => onDeleteColumn(column)}>
							<Trash2 className="size-4" />
							Delete column…
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
