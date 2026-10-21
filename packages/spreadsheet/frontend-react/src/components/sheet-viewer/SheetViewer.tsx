import type { Highlight } from '@glideapps/glide-data-grid';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AiFillDialog } from '@/components/ai/AiFillDialog';
import { AiPanel } from '@/components/ai/AiPanel';
import { CleanupDialog } from '@/components/ai/CleanupDialog';
import { ImportDocumentDialog } from '@/components/ai/ImportDocumentDialog';
import { ErrorState } from '@/components/common/ErrorState';
import { Button } from '@/components/ui/button';
import { suggestChart } from '@/lib/charts/suggest-chart';
import { useChartStore } from '@/stores/chart-store';
import { cellInputText } from '@/lib/editing/cell-input';
import { draftsToOptions, suggestedOptionDrafts } from '@/lib/editing/column-drafts';
import { SheetEditor, useSheetEditor } from '@/lib/editing/sheet-editor';
import { CachedFormulaDataResolver } from '@/lib/formulas/dependency-resolver';
import { FormulaRuntime } from '@/lib/formulas/formula-runtime';
import { defaultFields } from '@/lib/forms/fields';
import { useFormStore } from '@/stores/form-store';
import { activeSearchHighlightColor, searchHighlightColor } from '@/lib/grid/grid-theme';
import { SheetGridController, type GridContextMenuTarget } from '@/lib/grid/sheet-grid-controller';
import { useSheetGridController } from '@/lib/grid/use-sheet-grid-controller';
import { queryKeys } from '@/lib/queries/keys';
import { columnsQueryOptions, sheetQueryOptions } from '@/lib/queries/sheets';
import { sheetRepository, type ColumnDeleteResult, type ColumnUpdateInput, type ColumnUpdateResult } from '@/lib/storage';
import { columnTypeLabel, validateColumnUpdate } from '@/lib/storage/sheet-schema';
import { useRowHeight } from '@/stores/preferences';
import { recentSheets } from '@/stores/recent-sheets';
import { SheetRowStore, useSheetRowStore } from '@/lib/stores/sheet-row-store';
import { SheetSearch, useSheetSearch } from '@/lib/stores/sheet-search';
import type { Column, KnownColumnType } from '@/lib/types';
import { toStringList } from '@/lib/utils/cell-values';
import { AddColumnDialog } from './AddColumnDialog';
import { DeleteColumnDialog } from './DeleteColumnDialog';
import { EditColumnDialog } from './EditColumnDialog';
import { FormulaBar } from './FormulaBar';
import { GridContextMenu } from './GridContextMenu';
import { GridSkeleton } from './GridSkeleton';
import { GroupColumnsDialog } from './GroupColumnsDialog';
import { SheetGrid } from './SheetGrid';
import { SheetHeader } from './SheetHeader';

interface Pipeline {
	store: SheetRowStore;
	resolver: CachedFormulaDataResolver;
	runtime: FormulaRuntime;
	controller: SheetGridController;
	search: SheetSearch;
}

function createPipeline(sheetId: string, queryClient: ReturnType<typeof useQueryClient>): Pipeline {
	const store = new SheetRowStore(sheetId, queryClient);
	const resolver = new CachedFormulaDataResolver(queryClient, store);
	const runtime = new FormulaRuntime({ sheetId, columns: [], rows: store, resolver });
	const controller = new SheetGridController(store, runtime);
	const search = new SheetSearch(store, runtime, () => controller.getColumnsSnapshot());
	return { store, resolver, runtime, controller, search };
}

/**
 * Thin wrapper around `SheetViewerInner` whose only job is constructing and
 * tearing down the per-sheet pipeline (row store, formula runtime, grid
 * controller, search) inside a `useEffect` rather than a `useState` lazy
 * initializer.
 *
 * This matters because `SheetGridController`'s constructor subscribes to
 * `store`/`runtime` as an inherent part of construction (by original Svelte
 * design — see that class's own header comment), and under React 18
 * StrictMode's dev-only "mount, synthetically clean up, remount" cycle, a
 * `useState(() => new X())` initializer runs once (state survives the
 * synthetic remount) while a separate cleanup-only `useEffect` still runs
 * its cleanup on the synthetic unmount — permanently unsubscribing the
 * controller with no corresponding resubscribe, since nothing re-runs the
 * constructor. The grid still *looks* fine afterwards (glide-data-grid pulls
 * cell content fresh on every React re-render, independent of this
 * subscription), but formula cells never compute until something else
 * (e.g. `SheetEditor.commit`) calls `runtime.enqueueRows` through a
 * different path — found via live Chrome verification, not a type error.
 * Building the pipeline inside the effect itself keeps setup and teardown
 * paired 1:1 on every mount/unmount, synthetic or real.
 */
export function SheetViewer({ sheetId }: { sheetId: string }) {
	const queryClient = useQueryClient();
	const [pipeline, setPipeline] = useState<Pipeline | null>(null);

	useEffect(() => {
		const created = createPipeline(sheetId, queryClient);
		setPipeline(created);
		return () => {
			created.controller.destroy();
			created.runtime.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sheetId, queryClient]);

	if (!pipeline) return null;
	return <SheetViewerInner sheetId={sheetId} {...pipeline} />;
}

function SheetViewerInner({ sheetId, store, resolver, runtime, controller, search }: Pipeline & { sheetId: string }) {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const sheet = useQuery(sheetQueryOptions(sheetId));
	const columns = useQuery(columnsQueryOptions(sheetId));
	const rowHeight = useRowHeight();
	const createChart = useChartStore((state) => state.create);
	const createForm = useFormStore((state) => state.create);

	const liveStore = useSheetRowStore(store);
	const liveController = useSheetGridController(controller);
	const liveSearch = useSheetSearch(search);

	/** Present only when the sheet's storage adapter accepts edits. */
	const [editor, setEditor] = useState<SheetEditor | null>(null);
	const liveEditor = useSheetEditor(editor);
	const editorRef = useRef<SheetEditor | null>(null);
	useEffect(() => {
		editorRef.current = editor;
	}, [editor]);

	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		if (sheet.data) store.setTotalRows(sheet.data.row_count);
	}, [sheet.data, store]);

	// Listed under "Recent" on the Overview once the sheet has loaded.
	const recorded = useRef(false);
	useEffect(() => {
		if (!sheet.data || recorded.current) return;
		recorded.current = true;
		recentSheets.record(sheet.data.id);
	}, [sheet.data]);

	useEffect(() => {
		if (columns.data) controller.setColumns(columns.data);
	}, [columns.data, controller]);

	// Opened from a report (`?row=<id>`): select that row once the grid knows its columns.
	const revealedRowId = useRef<string | null>(null);
	useEffect(() => {
		const rowId = searchParams.get('row');
		if (!rowId || rowId === revealedRowId.current || !columns.data || !sheet.data) return;
		revealedRowId.current = rowId;
		void sheetRepository
			.getRow(sheetId, rowId)
			.then((detail) => setTimeout(() => controller.revealRow(detail.row_number), 150))
			.catch(() => showNotice('That row is no longer in this sheet.'));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, columns.data, sheet.data]);

	// Paired setup/teardown in the same effect — see the StrictMode note on
	// `SheetViewer` above; a separate cleanup-only effect would leave this
	// editor's runtime subscription (formula value caching) dead after the
	// dev-mode synthetic remount, with no way for a later effect run to tell.
	useEffect(() => {
		if (!sheet.data?.writable) return;
		const created = new SheetEditor({
			sheetId,
			queryClient,
			store,
			runtime,
			resolver,
			columns: () => controller.getColumnsSnapshot(),
			onColumnsChanged: refreshColumns
		});
		setEditor(created);
		controller.setEditor(created);
		return () => {
			created.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sheet.data?.writable]);

	// Search loaded rows; re-run as more blocks arrive.
	useEffect(() => {
		const timer = setTimeout(() => search.run(), 120);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveSearch.query, liveStore.version]);

	const activeMatchKey = liveSearch.active ? `${liveSearch.query} ${liveSearch.active.rowId} ${liveSearch.active.column}` : '';

	useEffect(() => {
		if (!activeMatchKey) return;
		const match = liveSearch.active!;
		const visibleRow = liveStore.offsetToVisible(match.offset);
		if (visibleRow >= 0) controller.scrollTo(visibleRow, match.column);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeMatchKey]);

	const highlightRegions: Highlight[] = (() => {
		void liveStore.visibleRowCount; // collapse/expand changes visible positions
		const active = liveSearch.active;
		const regions: Highlight[] = [];
		for (const match of liveSearch.matches.slice(0, 1_000)) {
			const y = liveStore.offsetToVisible(match.offset);
			if (y < 0) continue;
			regions.push({
				color: match === active ? activeSearchHighlightColor : searchHighlightColor,
				range: { x: match.column, y, width: 1, height: 1 },
				style: 'no-outline'
			});
		}
		return regions;
	})();

	async function refresh() {
		if (refreshing) return;
		setRefreshing(true);
		try {
			runtime.clear();
			resolver.clear();
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.sheetDetail(sheetId) }),
				queryClient.invalidateQueries({ queryKey: queryKeys.columns(sheetId) }),
				store.refresh()
			]);
		} finally {
			setRefreshing(false);
		}
	}

	// -- Column editing -------------------------------------------------------------

	const [editingColumn, setEditingColumn] = useState<Column | null>(null);
	const [columnDialogOpen, setColumnDialogOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout>>();

	// -- Context menu ---------------------------------------------------------------

	const [contextMenuOpen, setContextMenuOpen] = useState(false);
	const [addColumnAfter, setAddColumnAfter] = useState<string | undefined>(undefined);

	/** The target the menu is showing; stays stable while the menu animates closed. */
	const [shownTarget, setShownTarget] = useState<GridContextMenuTarget | null>(null);

	// Open the menu at the new position whenever the grid reports a target
	// (closing first so a second right-click repositions it).
	useEffect(() => {
		const target = liveController.contextMenu;
		setContextMenuOpen(false);
		if (!target) return;
		let cancelled = false;
		queueMicrotask(() => {
			if (cancelled || liveController.contextMenu !== target) return;
			setShownTarget(target);
			setContextMenuOpen(true);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveController.contextMenu]);

	/** A menu replaced by a newer right-click must not clear the newer target when it closes. */
	function onContextMenuClose() {
		if (controller.contextMenu === shownTarget) controller.closeContextMenu();
	}

	const menuTarget = shownTarget;
	const menuColumn = menuTarget ? (columns.data ?? []).find((column) => column.key === menuTarget.columnKey) : undefined;
	const menuRow = menuTarget?.kind === 'cell' ? liveStore.getLoadedRow(menuTarget.rowId) : undefined;
	const menuLevelRows = menuTarget?.kind === 'cell' ? controller.rowsForLevelChange(menuTarget.rowId) : [];
	const menuLevelAvailability = controller.levelChangeAvailability(menuLevelRows);
	const menuGroupMenu = menuTarget?.kind === 'column' ? controller.columnGroupMenuFor(menuTarget.columnKey) : { kind: 'none' as const };
	/** Selected columns the Actions menu's "Group columns" entry would act on (0 when they aren't adjacent). */
	const groupableColumnCount = controller.columnsAreContiguous(liveController.selectedColumnKeys) ? liveController.selectedColumnKeys.length : 0;

	async function runMenuAction(action: () => unknown, failure: string) {
		try {
			await action();
		} catch (error) {
			showNotice(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function openAddColumn(afterColumnKey?: string) {
		setAddColumnAfter(afterColumnKey);
		setAddColumnOpen(true);
	}

	function insertColumn(column: Column, side: 'left' | 'right') {
		if (side === 'right') return openAddColumn(column.key);
		const list = columns.data ?? [];
		const index = list.findIndex((candidate) => candidate.key === column.key);
		openAddColumn(index > 0 ? list[index - 1].key : undefined);
	}

	function editColumn(column: Column) {
		setEditingColumn(column);
		setColumnDialogOpen(true);
	}

	/** Distinct values already in the column (loaded rows), to seed enum options. */
	function suggestedOptions(): string[] {
		return editingColumn ? distinctValues(editingColumn.key) : [];
	}

	/**
	 * The context menu's "Change type": converts the column in place, keeping its name,
	 * formula and (when it still fits) default. Enums get options from existing values.
	 */
	async function changeColumnType(column: Column, type: KnownColumnType) {
		if (type === column.data_type) return;
		const formula = column.settings.column_formula ?? '';
		const options = type === 'enum' ? (column.settings.options?.length ? column.settings.options : draftsToOptions(suggestedOptionDrafts(distinctValues(column.key)))) : undefined;
		const input = (defaultInput: string): ColumnUpdateInput => ({
			name: column.name,
			data_type: type,
			settings: { ...(options ? { options } : {}), column_formula: formula },
			defaultInput: formula ? '' : defaultInput
		});
		const list = columns.data ?? [];
		let validation = validateColumnUpdate(list, column.key, input(cellInputText(column.settings.default_value)));
		// A default that doesn't fit the new type is dropped rather than blocking the change.
		if (!validation.ok) validation = validateColumnUpdate(list, column.key, input(''));
		if (!validation.ok) {
			showNotice(`Could not change to ${columnTypeLabel(type)}: ${validation.error}. Use Edit column… to adjust it.`);
			return;
		}
		const value = validation.value;
		await runMenuAction(async () => {
			const result = await sheetRepository.updateColumn(sheetId, column.key, value);
			await onColumnSaved(result, column);
		}, `Could not change to ${columnTypeLabel(type)}`);
	}

	/** Distinct values already in a column (loaded rows). */
	function distinctValues(key: string): string[] {
		const values = new Set<string>();
		for (const row of store.rows.values()) {
			for (const value of toStringList(row.data[key])) {
				values.add(value);
				if (values.size >= 50) return [...values];
			}
		}
		return [...values];
	}

	const [addColumnOpen, setAddColumnOpen] = useState(false);
	const [deletingColumn, setDeletingColumn] = useState<Column | null>(null);
	const [deleteColumnOpen, setDeleteColumnOpen] = useState(false);

	// -- Column groups ----------------------------------------------------------------

	const [groupDialogOpen, setGroupDialogOpen] = useState(false);
	const [groupDialogMode, setGroupDialogMode] = useState<'group' | 'rename'>('group');
	const [groupDialogColumnKeys, setGroupDialogColumnKeys] = useState<string[]>([]);
	const [groupDialogGroupName, setGroupDialogGroupName] = useState<string | undefined>(undefined);

	// -- AI ------------------------------------------------------------------------------

	const [aiPanelOpen, setAiPanelOpen] = useState(false);
	const [aiColumn, setAiColumn] = useState<Column | null>(null);
	const [cleanupOpen, setCleanupOpen] = useState(false);
	const [fillOpen, setFillOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);

	function openCleanup(column: Column) {
		setAiColumn(column);
		setCleanupOpen(true);
	}

	function openFill(column: Column) {
		setAiColumn(column);
		setFillOpen(true);
	}

	function onAiApplied(message: string) {
		showNotice(`${message}. Undo with Ctrl+Z.`);
	}

	// -- Charts & forms ---------------------------------------------------------------

	async function handleCreateChart() {
		const chart = createChart({ sheetId, ...suggestChart(columns.data ?? []) });
		navigate(`/charts/${chart.id}`);
	}

	async function handleCreateForm() {
		const form = createForm({
			sheetId,
			name: `${sheet.data?.name ?? 'Sheet'} form`,
			fields: defaultFields(columns.data ?? [])
		});
		navigate(`/forms/${form.id}/edit`);
	}

	function openGroupColumns(columnKeys: string[]) {
		setGroupDialogMode('group');
		setGroupDialogColumnKeys(columnKeys);
		setGroupDialogGroupName(undefined);
		setGroupDialogOpen(true);
	}

	function openRenameGroup(groupName: string) {
		setGroupDialogMode('rename');
		setGroupDialogGroupName(groupName);
		setGroupDialogColumnKeys([]);
		setGroupDialogOpen(true);
	}

	async function onColumnsGrouped(result: Column[]) {
		await refreshColumns();
		const name = result[0]?.settings.column_group ?? '';
		showNotice(groupDialogMode === 'group' ? `Grouped ${result.length} columns as “${name}”.` : `Renamed group to “${name}”.`);
	}

	// The grid's native hover "Rename" action on a group header (see SheetGridView).
	useEffect(() => {
		return controller.bindGroupRename((groupName, newName) =>
			runMenuAction(async () => {
				await sheetRepository.renameColumnGroup(sheetId, groupName, newName);
				await refreshColumns();
			}, 'Could not rename group')
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [controller]);

	/** Reloads columns and visible rows after the sheet's structure changed. */
	async function refreshColumns() {
		controller.clearSelection();
		// Messages about the previous column setup (e.g. a locked column) no longer apply.
		const currentEditor = editorRef.current;
		if (currentEditor) {
			currentEditor.lastError = null;
			// Column dialogs write through the repository directly, so pick up their undo steps.
			currentEditor.syncHistory();
		}
		runtime.clear();
		resolver.clear();
		await queryClient.invalidateQueries({ queryKey: queryKeys.columns(sheetId) });
		await store.refresh();
		void queryClient.invalidateQueries({ queryKey: queryKeys.sheetDetail(sheetId) });
		void queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
	}

	function showNotice(message: string) {
		setNotice(message);
		clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 6_000);
	}

	async function onColumnAdded(column: Column) {
		await refreshColumns();
		showNotice(`Added column “${column.name}” (${columnTypeLabel(column.data_type)}).`);
	}

	function requestDeleteColumn(column: Column) {
		setDeletingColumn(column);
		setDeleteColumnOpen(true);
	}

	async function onColumnDeleted(result: ColumnDeleteResult) {
		await refreshColumns();
		const details = [
			result.filledCells ? `${result.filledCells} cells deleted` : null,
			result.formulaReferences ? `${result.formulaReferences} formulas now show #REF!` : null
		].filter(Boolean);
		showNotice(`Deleted column “${result.column.name}”${details.length ? ` · ${details.join(' · ')}` : ''}.`);
	}

	async function onColumnSaved(result: ColumnUpdateResult, previous: Column) {
		await refreshColumns();

		const parts = [
			previous.name !== result.column.name ? `Renamed to “${result.column.name}”` : null,
			previous.data_type !== result.column.data_type ? `type changed to ${columnTypeLabel(result.column.data_type)}` : null,
			result.convertedCells ? `${result.convertedCells} cells converted` : null,
			result.clearedCells ? `${result.clearedCells} cells cleared` : null,
			result.formulasUpdated ? `${result.formulasUpdated} formulas updated` : null,
			result.formulaCellsApplied ? `column formula applied to ${result.formulaCellsApplied} cells` : null
		].filter(Boolean);
		const summary = parts.join(' · ');
		showNotice(summary ? `${summary[0].toUpperCase()}${summary.slice(1)}.` : 'Column saved.');
	}

	async function deleteSheet() {
		await sheetRepository.deleteSheet(sheetId);
		queryClient.removeQueries({ queryKey: queryKeys.sheet(sheetId) });
		await queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
		navigate('/sheets');
	}

	// -- Undo / redo ------------------------------------------------------------------

	async function travel(direction: 'undo' | 'redo') {
		if (!editor) return;
		try {
			const step = await editor[direction]();
			if (step) showNotice(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}`);
		} catch (error) {
			showNotice(`Could not ${direction}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Ctrl/⌘+Z undoes; Ctrl/⌘+Shift+Z and Ctrl+Y redo. */
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			const currentEditor = editorRef.current;
			if (!currentEditor || !(event.ctrlKey || event.metaKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : null;
			if (!direction) return;
			// Text fields keep their own undo, and dialogs or menus shouldn't change the sheet behind them.
			const target = event.target;
			if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]')) {
				return;
			}
			event.preventDefault();
			void travel(direction);
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SheetHeader
				sheet={sheet.data}
				loading={sheet.isPending}
				fetchingRows={liveStore.pendingBlocks > 0 || refreshing}
				loadedRows={liveStore.version >= 0 ? liveStore.loadedRowCount : 0}
				collapsedCount={liveStore.collapsedCount}
				refreshing={refreshing}
				search={search}
				onRefresh={refresh}
				onExpandAll={() => controller.expandAll()}
				editable={editor !== null}
				saving={(liveEditor?.pendingWrites ?? 0) > 0}
				saveError={liveEditor?.lastError ?? null}
				lastSavedAt={liveEditor?.lastSavedAt ?? null}
				selectedRowCount={liveController.selectedRowIds.length}
				groupableColumnCount={groupableColumnCount}
				history={liveEditor?.history ?? { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }}
				onUndo={() => travel('undo')}
				onRedo={() => travel('redo')}
				onAddRow={() => controller.appendRow()}
				onAddColumn={() => openAddColumn()}
				onDeleteRows={() => controller.deleteSelectedRows()}
				onGroupColumns={() => openGroupColumns(liveController.selectedColumnKeys)}
				onImportDocument={() => setImportOpen(true)}
				onCreateChart={handleCreateChart}
				onCreateForm={handleCreateForm}
				onOpenAi={() => setAiPanelOpen(true)}
				onDeleteSheet={deleteSheet}
			/>

			<div className="relative min-h-0 flex-1">
				{sheet.isError || columns.isError ? (
					<ErrorState
						title="Could not open this sheet"
						error={sheet.error ?? columns.error}
						onRetry={() => {
							sheet.refetch();
							columns.refetch();
						}}
					/>
				) : sheet.isPending || columns.isPending ? (
					<GridSkeleton />
				) : (
					<>
						<SheetGrid controller={controller} rowCount={liveStore.visibleRowCount} rowHeight={rowHeight} highlightRegions={highlightRegions} />
						{editor && liveStore.totalRows === 0 && (
							<div className="pointer-events-none absolute inset-x-0 top-28 flex justify-center">
								<div className="pointer-events-auto flex flex-col items-center gap-3 rounded-xl border bg-background px-8 py-6 text-center shadow-sm">
									<div>
										<p className="font-medium">This sheet is empty</p>
										<p className="mt-1 text-sm text-muted-foreground">
											Add a row, then type values or formulas like <code className="font-mono text-xs">=[Quantity] * 2</code>.
										</p>
									</div>
									<Button size="sm" onClick={() => controller.appendRow()}>
										<Plus className="size-4" />
										Add first row
									</Button>
								</div>
							</div>
						)}
						{notice && (
							<div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 shadow-sm" role="status">
								{notice}
							</div>
						)}
						{liveStore.lastError && (
							<div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 shadow-sm">
								Some rows failed to load. Scroll or refresh to retry.
							</div>
						)}
					</>
				)}
			</div>

			{editor && (
				<>
					<EditColumnDialog
						open={columnDialogOpen}
						onOpenChange={setColumnDialogOpen}
						sheetId={sheetId}
						column={editingColumn}
						columns={columns.data ?? []}
						suggestedOptions={suggestedOptions}
						onSaved={onColumnSaved}
						canDelete={(columns.data?.length ?? 0) > 1}
						onRequestDelete={requestDeleteColumn}
					/>
					<AddColumnDialog open={addColumnOpen} onOpenChange={setAddColumnOpen} sheetId={sheetId} columns={columns.data ?? []} initialAfterColumnKey={addColumnAfter} onAdded={onColumnAdded} />
					<DeleteColumnDialog open={deleteColumnOpen} onOpenChange={setDeleteColumnOpen} sheetId={sheetId} column={deletingColumn} onDeleted={onColumnDeleted} />
					<GroupColumnsDialog
						open={groupDialogOpen}
						onOpenChange={setGroupDialogOpen}
						sheetId={sheetId}
						mode={groupDialogMode}
						columnKeys={groupDialogColumnKeys}
						groupName={groupDialogGroupName}
						onSaved={onColumnsGrouped}
					/>
					{sheet.data && (
						<>
							<CleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} sheet={sheet.data} column={aiColumn} columns={columns.data ?? []} editor={editor} onApplied={onAiApplied} />
							<AiFillDialog open={fillOpen} onOpenChange={setFillOpen} sheet={sheet.data} column={aiColumn} columns={columns.data ?? []} editor={editor} onApplied={onAiApplied} />
							<ImportDocumentDialog open={importOpen} onOpenChange={setImportOpen} sheet={sheet.data} columns={columns.data ?? []} editor={editor} onApplied={onAiApplied} />
						</>
					)}
				</>
			)}

			{sheet.data && (
				<AiPanel
					open={aiPanelOpen}
					onOpenChange={setAiPanelOpen}
					sheet={sheet.data}
					columns={columns.data ?? []}
					editor={editor}
					onRevealRow={(position, columnKey) => controller.revealRow(position, columnKey)}
					onApplied={onAiApplied}
				/>
			)}

			<GridContextMenu
				open={contextMenuOpen}
				onOpenChange={setContextMenuOpen}
				target={menuTarget}
				column={menuColumn}
				row={menuRow}
				rowNumber={menuTarget?.kind === 'cell' ? liveStore.getRowNumber(menuTarget.rowId) : undefined}
				editable={editor !== null}
				collapsed={menuRow ? liveStore.isCollapsed(menuRow.id) : false}
				rowsToDelete={menuTarget?.kind === 'cell' ? controller.rowsForDeletion(menuTarget.rowId).length : 0}
				levelRows={menuLevelRows.length}
				canIndent={menuLevelAvailability.indent}
				canOutdent={menuLevelAvailability.outdent}
				onIndent={(target) => runMenuAction(() => controller.changeRowLevel('indent', controller.rowsForLevelChange(target.rowId)), 'Could not indent')}
				onOutdent={(target) => runMenuAction(() => controller.changeRowLevel('outdent', controller.rowsForLevelChange(target.rowId)), 'Could not outdent')}
				canDeleteColumn={(columns.data?.length ?? 0) > 1}
				groupMenu={menuGroupMenu}
				onGroupColumns={openGroupColumns}
				onRenameGroup={openRenameGroup}
				onCleanColumn={openCleanup}
				onFillColumn={openFill}
				onUngroupColumns={(keys) =>
					runMenuAction(async () => {
						await sheetRepository.ungroupColumns(sheetId, keys);
						await refreshColumns();
					}, 'Could not ungroup columns')
				}
				onClose={onContextMenuClose}
				onRestoreFocus={() => controller.focusGrid()}
				onCopy={() => runMenuAction(() => controller.copySelection(), 'Could not copy')}
				onPaste={(target) =>
					runMenuAction(() => controller.pasteClipboardAt(target.item), `Could not read the clipboard (you can also paste with ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}V)`)
				}
				onClear={() => controller.clearSelectedCells()}
				onToggleRow={(target) => controller.toggleRow(target.rowId)}
				onInsertRow={(target, where) => runMenuAction(() => controller.insertRowNear(target.rowId, where), 'Could not insert a row')}
				onDeleteRows={(target) => runMenuAction(() => controller.deleteRowsFor(target.rowId), 'Could not delete rows')}
				onEditColumn={editColumn}
				onChangeColumnType={changeColumnType}
				onInsertColumn={insertColumn}
				onDeleteColumn={requestDeleteColumn}
			/>

			<FormulaBar selected={liveController.selected} columns={columns.data ?? []} editable={liveController.editable} onCommit={(raw) => controller.commitSelectedInput(raw)} />
		</div>
	);
}
