import { Check, ChevronRight, CircleAlert, Eye, Globe, HardDrive, ListTree, LoaderCircle, Redo2, RefreshCw, Sparkles, Table2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { HistoryState } from '@/lib/storage';
import type { SheetSearch } from '@/lib/stores/sheet-search';
import type { Sheet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatCount, formatRelativeTime } from '@/lib/utils/format';
import { SheetActionsMenu } from './SheetActionsMenu';
import { SheetSearchInput } from './SheetSearchInput';

/** Ported from components/sheet-viewer/SheetHeader.svelte. */
export function SheetHeader({
	sheet,
	loading,
	fetchingRows,
	loadedRows,
	collapsedCount,
	refreshing,
	search,
	onRefresh,
	onExpandAll,
	editable,
	saving,
	saveError,
	lastSavedAt,
	selectedRowCount,
	groupableColumnCount,
	history,
	onUndo,
	onRedo,
	onAddRow,
	onAddColumn,
	onDeleteRows,
	onGroupColumns,
	onImportDocument,
	onOpenAi,
	onDeleteSheet,
	onCreateChart,
	onCreateForm
}: {
	sheet: Sheet | undefined;
	loading: boolean;
	fetchingRows: boolean;
	loadedRows: number;
	collapsedCount: number;
	refreshing: boolean;
	search: SheetSearch;
	onRefresh: () => void;
	onExpandAll: () => void;
	editable: boolean;
	saving: boolean;
	saveError: string | null;
	lastSavedAt: number | null;
	selectedRowCount: number;
	groupableColumnCount: number;
	history: HistoryState;
	onUndo: () => void;
	onRedo: () => void;
	onAddRow: () => void;
	onAddColumn: () => void;
	onDeleteRows: () => void;
	onGroupColumns: () => void;
	onImportDocument: () => void;
	onOpenAi: () => void;
	onDeleteSheet: () => Promise<void>;
	onCreateChart: () => void;
	onCreateForm: () => void;
}) {
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);

	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	const undoShortcut = isMac ? '⌘Z' : 'Ctrl+Z';
	const redoShortcut = isMac ? '⇧⌘Z' : 'Ctrl+Y';

	async function confirmDelete() {
		setDeleting(true);
		try {
			await onDeleteSheet();
		} finally {
			setDeleting(false);
			setDeleteOpen(false);
		}
	}

	const savedLabel = sheet?.source === 'icp' ? 'Saved on the ICP canister' : 'Saved in this browser';

	return (
		<>
			<header className="relative border-b bg-background">
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
					<div className="min-w-0">
						<nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
							<Link to="/sheets" className="hover:text-foreground">
								Sheets
							</Link>
							<ChevronRight className="size-3" />
							<span className="truncate">{sheet?.name ?? '…'}</span>
						</nav>

						<div className="mt-0.5 flex items-center gap-2.5">
							<Table2 className="size-5 shrink-0 text-emerald-600" />
							{loading ? <Skeleton className="h-6 w-56" /> : <h1 className="truncate text-lg font-semibold tracking-tight">{sheet?.name}</h1>}
							{sheet?.source === 'local' ? (
								<Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 font-medium text-emerald-700">
									<HardDrive className="size-3" />
									Local · editable
								</Badge>
							) : sheet?.source === 'icp' ? (
								<Badge variant="outline" className="gap-1 border-violet-200 bg-violet-50 font-medium text-violet-700">
									<Globe className="size-3" />
									ICP · editable
								</Badge>
							) : sheet ? (
								<Badge variant="secondary" className="gap-1 font-medium">
									<Eye className="size-3" />
									View only
								</Badge>
							) : null}
						</div>

						<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
							{sheet ? (
								<>
									<span>{formatCount(sheet.row_count)} rows</span>
									<span aria-hidden="true">·</span>
									<span>{sheet.column_count} columns</span>
									<span aria-hidden="true">·</span>
									<span title={new Date(sheet.updated_at).toLocaleString()}>Updated {formatRelativeTime(sheet.updated_at)}</span>
									{editable ? (
										<>
											<span aria-hidden="true">·</span>
											{saving ? (
												<span className="flex items-center gap-1">
													<LoaderCircle className="size-3 animate-spin" /> Saving…
												</span>
											) : saveError ? (
												<span className="flex max-w-72 items-center gap-1 truncate text-red-600" title={saveError}>
													<CircleAlert className="size-3 shrink-0" />
													{saveError}
												</span>
											) : lastSavedAt ? (
												<span className="flex items-center gap-1 text-emerald-700">
													<Check className="size-3" /> {savedLabel}
												</span>
											) : (
												<span>{savedLabel}</span>
											)}
										</>
									) : (
										<>
											<span aria-hidden="true">·</span>
											<span>{formatCount(loadedRows)} in memory</span>
										</>
									)}
								</>
							) : (
								<Skeleton className="h-3 w-64" />
							)}
						</div>
					</div>

					<div className="ml-auto flex items-center gap-2">
						{fetchingRows && <span className="hidden text-xs text-muted-foreground lg:inline">Loading rows…</span>}

						<SheetSearchInput search={search} />

						{collapsedCount > 0 && (
							<Button variant="outline" size="sm" className="h-8" onClick={onExpandAll}>
								<ListTree className="size-4" />
								Expand all
							</Button>
						)}

						{editable && (
							<div className="flex items-center" role="group" aria-label="History">
								<Tooltip>
									<TooltipTrigger asChild>
										{/* Wrapper keeps the tooltip working while the button is disabled. */}
										<span className="inline-flex">
											<Button
												variant="outline"
												size="icon"
												className="size-8 rounded-r-none"
												onClick={onUndo}
												disabled={!history.canUndo}
												aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
											>
												<Undo2 className="size-4" />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{history.undoLabel ? `Undo: ${history.undoLabel}` : 'Nothing to undo'}
										<span className="ml-1.5 opacity-60">{undoShortcut}</span>
									</TooltipContent>
								</Tooltip>
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="-ml-px inline-flex">
											<Button
												variant="outline"
												size="icon"
												className="size-8 rounded-l-none"
												onClick={onRedo}
												disabled={!history.canRedo}
												aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
											>
												<Redo2 className="size-4" />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{history.redoLabel ? `Redo: ${history.redoLabel}` : 'Nothing to redo'}
										<span className="ml-1.5 opacity-60">{redoShortcut}</span>
									</TooltipContent>
								</Tooltip>
							</div>
						)}

						<Button variant="outline" size="sm" className="h-8 border-violet-200 text-violet-700 hover:bg-violet-50 hover:text-violet-800" onClick={onOpenAi}>
							<Sparkles className="size-4" />
							AI
						</Button>

						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="outline" size="icon" className="size-8" onClick={onRefresh} disabled={refreshing} aria-label="Refresh data">
									<RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Refresh data</TooltipContent>
						</Tooltip>

						<SheetActionsMenu
							editable={editable}
							selectedRowCount={selectedRowCount}
							groupableColumnCount={groupableColumnCount}
							onAddRow={onAddRow}
							onAddColumn={onAddColumn}
							onDeleteRows={onDeleteRows}
							onGroupColumns={onGroupColumns}
							onImportDocument={onImportDocument}
							onCreateChart={onCreateChart}
							onCreateForm={onCreateForm}
							onDeleteSheet={() => setDeleteOpen(true)}
						/>
					</div>
				</div>

				{fetchingRows && (
					<div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" role="progressbar" aria-label="Loading rows">
						<div className="silver-progress-bar h-full w-1/3 bg-blue-500/70" />
					</div>
				)}
			</header>

			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete “{sheet?.name}”?</AlertDialogTitle>
						<AlertDialogDescription>This removes the sheet and all of its rows from this browser. It can't be undone.</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
						<AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" disabled={deleting} onClick={confirmDelete}>
							{deleting ? 'Deleting…' : 'Delete sheet'}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
