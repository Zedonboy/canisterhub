import {
	CompactSelection,
	GridCellKind,
	GridColumnIcon,
	type CellClickedEventArgs,
	type DataEditorRef,
	type EditableGridCell,
	type GridCell,
	type GridColumn,
	type GridKeyEventArgs,
	type GridSelection,
	type Item,
	type Rectangle,
	type Theme
} from '@glideapps/glide-data-grid';
import { cellInputText } from '@/lib/editing/cell-input';
import type { CellInput, SheetEditor } from '@/lib/editing/sheet-editor';
import type { FormulaCellKey, FormulaRuntime } from '@/lib/formulas/formula-runtime';
import type { FormulaResult } from '@/lib/formulas/formula-types';
import type { RowStoreEvent, SheetRowStore } from '@/lib/stores/sheet-row-store';
import type { Column, EnumOption, RowData } from '@/lib/types';
import { cellPrimitive, isFormulaCell } from '@/lib/types';
import { theme } from '@/stores/theme';
import { cellDisplayText, PROTECTED_MASK } from './cell-text';
import { createGridCell, getColumnType } from './column-types';
import { darkParentRowTheme, gridTheme, parentRowTheme } from './grid-theme';
import { loadingCell } from './renderers/basic';
import { toggleHitArea } from './renderers/hierarchy';

/**
 * Ported from lib/grid/sheet-grid-controller.svelte.ts (deferred here from
 * Phase 2 — see that phase's commit for why: this file transitively pulls
 * in the whole grid-rendering subsystem, which belongs with Phase 5).
 * `$state`/`$state.raw` fields become plain-field accessor pairs
 * (get/set) that call `notify()` on write, backing a minimal pub/sub
 * (`subscribe`) added here — the Svelte version got this for free from
 * runes; React's `useSheetGridController` hook (below) wraps it with
 * `useSyncExternalStore`. No other logic changes.
 */

export interface SelectedCellInfo {
	rowId: string;
	columnKey: string;
	rowNumber: number;
	columnName: string;
	columnType: string;
	display: string;
	raw: string;
	/** Editable text: the formula source for formula cells, else the stored value. */
	input: string;
	formula?: string;
	result?: FormulaResult;
	/** Protected column: value must not be shown in plain text. */
	secret: boolean;
	/** Calculated by a column formula: not editable per cell. */
	locked: boolean;
}

/** What the overlay editor needs to know about the cell being edited. */
export interface CellEditMeta {
	rowId: string;
	columnKey: string;
	input: string;
	/** Which overlay editor to use. */
	editor: 'text' | 'enum' | 'markdown' | 'secret';
	placeholder?: string;
	/** Present for enum columns: the editor offers these instead of free text. */
	options?: EnumOption[];
}

const EDIT_PLACEHOLDERS: Partial<Record<string, string>> = {
	uri: 'https://example.com',
	image: 'Image URLs, comma separated',
	bubble: 'Tags, comma separated',
	drilldown: 'Label | image URL, comma separated',
	date: 'YYYY-MM-DD',
	markdown: 'Markdown text (Shift+Enter for a new line)'
};

function editorFor(column: Column): CellEditMeta['editor'] {
	switch (column.data_type) {
		case 'enum':
			return 'enum';
		case 'markdown':
			return 'markdown';
		case 'protected':
			return 'secret';
		default:
			return 'text';
	}
}

const MAX_SELECTED_ROWS = 5_000;
const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** What a right-click (or header menu button) targeted; `x`/`y` are viewport coordinates. */
export type GridContextMenuTarget =
	| { kind: 'cell'; x: number; y: number; item: Item; rowId: string; columnKey: string }
	| { kind: 'column'; x: number; y: number; columnKey: string };

/** What the header context menu's group action(s) should offer for the targeted column(s). */
export type ColumnGroupMenuState =
	| { kind: 'none' }
	/** 2+ contiguous, ungrouped (or mixed-group) columns: offer to group them. */
	| { kind: 'create'; keys: string[] }
	/** 2+ columns selected but not adjacent: explain why grouping is unavailable. */
	| { kind: 'create-disabled'; count: number }
	/** The targeted column(s) already share one group: offer to rename or ungroup it. */
	| { kind: 'existing'; groupName: string; keys: string[] };

interface PositionedGridEvent {
	preventDefault: () => void;
	bounds: Rectangle;
	localEventX: number;
	localEventY: number;
}

/**
 * Bridges IntelliSheet's data layer (row store + formula runtime) and Glide.
 *
 * Glide pulls cells synchronously through `getCellContent`; this controller
 * answers from the row cache and pushes targeted redraws (`updateCells`) when
 * rows arrive or formula results change. For writable sheets it also routes
 * edits, paste, delete and row appends to the SheetEditor.
 */
export class SheetGridController {
	private _gridColumns: GridColumn[] = [];
	get gridColumns(): GridColumn[] {
		return this._gridColumns;
	}
	set gridColumns(value: GridColumn[]) {
		this._gridColumns = value;
		this.notify();
	}

	private _freezeColumns = 1;
	get freezeColumns(): number {
		return this._freezeColumns;
	}
	set freezeColumns(value: number) {
		this._freezeColumns = value;
		this.notify();
	}

	private _selected: SelectedCellInfo | null = null;
	get selected(): SelectedCellInfo | null {
		return this._selected;
	}
	set selected(value: SelectedCellInfo | null) {
		this._selected = value;
		this.notify();
	}

	private _selectedRowIds: string[] = [];
	get selectedRowIds(): string[] {
		return this._selectedRowIds;
	}
	set selectedRowIds(value: string[]) {
		this._selectedRowIds = value;
		this.notify();
	}

	/** Column keys selected in the header (click, or shift/ctrl-click to extend), in sheet order. */
	private _selectedColumnKeys: string[] = [];
	get selectedColumnKeys(): string[] {
		return this._selectedColumnKeys;
	}
	set selectedColumnKeys(value: string[]) {
		this._selectedColumnKeys = value;
		this.notify();
	}

	private _editable = false;
	get editable(): boolean {
		return this._editable;
	}
	set editable(value: boolean) {
		this._editable = value;
		this.notify();
	}

	/** Open context menu target, or null. */
	private _contextMenu: GridContextMenuTarget | null = null;
	get contextMenu(): GridContextMenuTarget | null {
		return this._contextMenu;
	}
	set contextMenu(value: GridContextMenuTarget | null) {
		this._contextMenu = value;
		this.notify();
	}

	private listeners = new Set<() => void>();
	private version = 0;
	/** For the `useSheetGridController` React hook (useSyncExternalStore); not in the Svelte original. */
	subscribeToChanges(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Snapshot value for useSyncExternalStore — bumped on every notify(), read fields stay on the instance itself. */
	getVersion(): number {
		return this.version;
	}
	private notify() {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	private lastSelection: GridSelection = EMPTY_SELECTION;
	private columns: Column[] = [];
	private columnIndex = new Map<string, number>();
	private primaryIndex = 0;
	private widths = new Map<string, number>();
	private ref: DataEditorRef | null = null;
	private viewport: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
	private selectedItem: Item | null = null;
	private editor: SheetEditor | null = null;
	/** Cells handed to Glide are looked up again when its overlay editor opens. */
	private editMeta = new WeakMap<GridCell, CellEditMeta>();
	/** Text typed into the open overlay editor, committed when it closes. */
	private pendingEdit: { rowId: string; columnKey: string; text: string } | null = null;
	private setGridSelection: ((selection: GridSelection) => void) | null = null;
	private groupRenameHandler: ((groupName: string, newName: string) => void) | null = null;
	private readonly unsubscribe: Array<() => void>;

	constructor(
		private readonly store: SheetRowStore,
		private readonly runtime: FormulaRuntime
	) {
		this.unsubscribe = [
			store.subscribe((event) => this.handleStoreEvent(event)),
			runtime.subscribe((cells) => this.handleFormulaResults(cells))
		];
	}

	destroy() {
		this.unsubscribe.forEach((fn) => fn());
		this.ref = null;
		this.setGridSelection = null;
		this.groupRenameHandler = null;
	}

	attach(ref: DataEditorRef | null) {
		this.ref = ref;
	}

	bindSelection(setter: ((selection: GridSelection) => void) | null) {
		this.setGridSelection = setter;
	}

	setEditor(editor: SheetEditor | null) {
		this.editor = editor;
		this.editable = editor !== null;
		this.rebuildGridColumns();
		this.damageViewport();
	}

	setColumns(columns: Column[]) {
		this.columns = columns;
		this.columnIndex = new Map(columns.map((column, index) => [column.key, index]));
		const primary = columns.findIndex((column) => column.settings.primary);
		this.primaryIndex = primary >= 0 ? primary : 0;
		this.freezeColumns = Math.min(columns.length, this.primaryIndex + 1);
		this.runtime.setColumns(columns);
		this.rebuildGridColumns();
	}

	getColumnsSnapshot(): Column[] {
		return this.columns;
	}

	getEditMeta(cell: GridCell): CellEditMeta | undefined {
		return this.editMeta.get(cell);
	}

	private rebuildGridColumns() {
		this.gridColumns = this.columns.map((column) => {
			const type = getColumnType(column.data_type);
			return {
				id: column.key,
				title: column.name,
				width: this.widths.get(column.key) ?? column.settings.width ?? type.defaultWidth,
				// ƒ marks columns calculated by a column formula.
				icon: column.settings.column_formula ? GridColumnIcon.HeaderMath : type.icon,
				overlayIcon: type.overlayIcon,
				// Editable sheets show a header menu for renaming / retyping the column.
				hasMenu: this.editable,
				// Adjacent columns sharing a group name get one header spanning them (Glide native).
				group: column.settings.column_group || undefined
			};
		});
	}

	// -- Glide callbacks (stable arrow functions) ---------------------------------

	getCellContent = ([col, visibleRow]: Item): GridCell => {
		const column = this.columns[col];
		const row = this.store.getRowAtVisible(visibleRow);
		if (!column || !row) return loadingCell;

		const value = row.data[column.key];
		// Column-formula cells stay read-only even in editable sheets.
		const cellEditable = this.editable && !column.settings.column_formula;
		const cell = createGridCell({
			column,
			row,
			value,
			formula: isFormulaCell(value) ? this.runtime.resultFor(row.id, column.key, value) : undefined,
			isPrimary: col === this.primaryIndex,
			collapsed: this.store.isCollapsed(row.id),
			editable: cellEditable
		});

		if (cellEditable) {
			this.editMeta.set(cell, {
				rowId: row.id,
				columnKey: column.key,
				input: cellInputText(value),
				editor: editorFor(column),
				placeholder: EDIT_PLACEHOLDERS[column.data_type],
				options: column.data_type === 'enum' ? (column.settings.options ?? []) : undefined
			});
		}
		return cell;
	};

	getRowThemeOverride = (visibleRow: number): Partial<Theme> | undefined =>
		this.store.getRowAtVisible(visibleRow)?.has_children ? (theme.dark ? darkParentRowTheme : parentRowTheme) : undefined;

	onVisibleRegionChanged = (range: Rectangle) => {
		this.viewport = range;
		this.store.ensureVisibleRange(range.y, range.y + range.height);
	};

	/** The header's menu button opens the column context menu below the header. */
	onHeaderMenuClick = (col: number, bounds: Rectangle) => {
		this.openColumnMenu(col, bounds.x, bounds.y + bounds.height);
	};

	/** Right-clicking a header opens the column context menu at the pointer. */
	onHeaderContextMenu = (col: number, event: PositionedGridEvent) => {
		if (!this.editable) return;
		event.preventDefault();
		this.openColumnMenu(col, event.bounds.x + event.localEventX, event.bounds.y + event.localEventY);
	};

	/** Right-clicking a cell selects it (unless it is already selected) and opens the cell context menu. */
	onCellContextMenu = (item: Item, event: CellClickedEventArgs) => {
		event.preventDefault();
		const target = this.cellAt(item);
		if (!target) return;

		if (!this.selectionContains(item)) {
			const selection: GridSelection = {
				current: { cell: item, range: { x: item[0], y: item[1], width: 1, height: 1 }, rangeStack: [] },
				columns: CompactSelection.empty(),
				rows: CompactSelection.empty()
			};
			this.setGridSelection?.(selection);
			this.onSelectionChange(selection);
		}

		this.contextMenu = {
			kind: 'cell',
			x: event.bounds.x + event.localEventX,
			y: event.bounds.y + event.localEventY,
			item,
			rowId: target.row.id,
			columnKey: target.column.key
		};
	};

	closeContextMenu() {
		this.contextMenu = null;
	}

	private openColumnMenu(col: number, x: number, y: number) {
		const column = this.columns[col];
		if (!column || !this.editable) return;
		this.contextMenu = { kind: 'column', x, y, columnKey: column.key };
	}

	private selectionContains([x, y]: Item): boolean {
		const selection = this.lastSelection;
		if (selection.rows.hasIndex(y)) return true;
		const ranges = selection.current ? [selection.current.range, ...selection.current.rangeStack] : [];
		return ranges.some((range) => x >= range.x && x < range.x + range.width && y >= range.y && y < range.y + range.height);
	}

	// -- Context menu commands ----------------------------------------------------------

	/** Copies the selected cells (or whole selected rows) as tab-separated display text. */
	async copySelection() {
		const text = this.selectionText();
		if (text !== null) await navigator.clipboard.writeText(text);
	}

	/** Pastes tab-separated clipboard text starting at `item`, parsed per target column. */
	async pasteClipboardAt(item: Item) {
		const text = await navigator.clipboard.readText();
		const rows = text
			.replace(/\r\n?/g, '\n')
			.replace(/\n$/, '')
			.split('\n')
			.map((line) => line.split('\t'));
		this.onPaste(item, rows);
	}

	clearSelectedCells() {
		this.onDelete(this.lastSelection);
	}

	async insertRowNear(rowId: string, where: 'above' | 'below') {
		if (!this.editor) return;
		if (where === 'above') await this.editor.insertRowsBefore(rowId);
		else await this.editor.insertRowsAfter(rowId);
	}

	/** Rows removed by "Delete row" on `rowId`: the row selection if it includes that row. */
	rowsForDeletion(rowId: string): string[] {
		return this.selectedRowIds.includes(rowId) ? this.selectedRowIds : [rowId];
	}

	async deleteRowsFor(rowId: string) {
		if (!this.editor) return;
		await this.editor.deleteRows(this.rowsForDeletion(rowId));
		this.clearSelection();
	}

	/** Rows that Indent/Outdent on `rowId` act on: the selected rows (or the selected range's rows) if they include it. */
	rowsForLevelChange(rowId: string): string[] {
		const rows = this.selectionRowIds();
		return rows.includes(rowId) ? rows : [rowId];
	}

	/**
	 * Whether any of `rowIds` can be indented (the row above is at the same level
	 * or deeper) or outdented (not top-level). Rows that aren't loaded are left to storage.
	 */
	levelChangeAvailability(rowIds: string[]): { indent: boolean; outdent: boolean } {
		let indent = false;
		let outdent = false;
		for (const rowId of rowIds) {
			const row = this.store.getLoadedRow(rowId);
			const offset = this.store.getRowOffset(rowId);
			if (!row || offset === undefined) return { indent: true, outdent: true };
			if (row.depth > 0) outdent = true;
			const above = offset > 0 ? this.store.getLoadedRowAt(offset - 1) : undefined;
			if (offset > 0 && (!above || above.depth >= row.depth)) indent = true;
		}
		return { indent, outdent };
	}

	async changeRowLevel(direction: 'indent' | 'outdent', rowIds: string[]) {
		if (!this.editor) return;
		if (direction === 'indent') await this.editor.indentRows(rowIds);
		else await this.editor.outdentRows(rowIds);
	}

	/** Columns a header action on `columnKey` targets: the multi-selection if it includes that column, else just it. */
	columnsForAction(columnKey: string): string[] {
		return this.selectedColumnKeys.includes(columnKey) ? this.selectedColumnKeys : [columnKey];
	}

	/** Whether `columnKeys`, in sheet order, occupy consecutive positions (required for one group header). */
	columnsAreContiguous(columnKeys: string[]): boolean {
		if (columnKeys.length < 2) return false;
		const indices = columnKeys.map((key) => this.columnIndex.get(key));
		if (indices.some((index) => index === undefined)) return false;
		const sorted = [...indices].sort((a, b) => a! - b!);
		return sorted.every((index, i) => i === 0 || index === sorted[i - 1]! + 1);
	}

	/** What the header context menu's group action(s) should offer for `columnKey` (and any wider selection it's part of). */
	columnGroupMenuFor(columnKey: string): ColumnGroupMenuState {
		const keys = this.columnsForAction(columnKey);
		const groupOf = (key: string) => this.columns[this.columnIndex.get(key) ?? -1]?.settings.column_group ?? null;
		const ownGroup = groupOf(columnKey);

		if (keys.length > 1 && ownGroup && keys.every((key) => groupOf(key) === ownGroup)) {
			return { kind: 'existing', groupName: ownGroup, keys };
		}
		if (ownGroup) return { kind: 'existing', groupName: ownGroup, keys: [columnKey] };
		if (keys.length > 1) {
			return this.columnsAreContiguous(keys) ? { kind: 'create', keys } : { kind: 'create-disabled', count: keys.length };
		}
		return { kind: 'none' };
	}

	/** Ctrl/⌘+] indents and Ctrl/⌘+[ outdents the selected rows. */
	onKeyDown = (event: GridKeyEventArgs) => {
		if (!this.editor || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
		if (event.key !== ']' && event.key !== '[') return;
		event.preventDefault();
		event.cancel();
		const rows = this.selectionRowIds();
		// Failures surface through the editor's error message.
		if (rows.length > 0) void this.changeRowLevel(event.key === ']' ? 'indent' : 'outdent', rows).catch(() => {});
	};

	focusGrid() {
		this.ref?.focus();
	}

	/** Selected rows, or else the rows spanned by the selected cell range. */
	private selectionRowIds(): string[] {
		if (this.selectedRowIds.length > 0) return this.selectedRowIds;
		const range = this.lastSelection.current?.range;
		if (!range) return [];
		const ids: string[] = [];
		for (let y = range.y; y < range.y + Math.min(range.height, MAX_SELECTED_ROWS); y++) {
			const row = this.store.getRowAtVisible(y);
			if (row) ids.push(row.id);
		}
		return ids;
	}

	private selectionText(): string | null {
		const selection = this.lastSelection;
		const rows = selection.rows.toArray().slice(0, MAX_SELECTED_ROWS);
		const lines: string[] = [];

		if (rows.length > 0) {
			for (const y of rows) lines.push(this.columns.map((_, x) => this.copyText([x, y])).join('\t'));
		} else if (selection.current) {
			const { x, y, width, height } = selection.current.range;
			for (let row = y; row < y + height; row++) {
				const cells: string[] = [];
				for (let col = x; col < x + width; col++) cells.push(this.copyText([col, row]));
				lines.push(cells.join('\t'));
			}
		} else {
			return null;
		}
		return lines.join('\n');
	}

	private copyText(item: Item): string {
		const target = this.cellAt(item);
		if (!target || target.column.data_type === 'protected') return '';
		const value = target.row.data[target.column.key];
		const result = isFormulaCell(value) ? this.runtime.resultFor(target.row.id, target.column.key, value) : undefined;
		return cellDisplayText(target.column, value, result);
	}

	onColumnResize = (column: GridColumn, newSize: number) => {
		if (!column.id) return;
		this.widths.set(column.id, newSize);
		this.rebuildGridColumns();
	};

	onCellClicked = ([col, visibleRow]: Item, event: CellClickedEventArgs) => {
		if (col !== this.primaryIndex) return;
		const row = this.store.getRowAtVisible(visibleRow);
		if (!row?.has_children) return;

		const padding = gridTheme.cellHorizontalPadding ?? 10;
		const [from, to] = toggleHitArea(row.depth, padding);
		if (event.localEventX >= from && event.localEventX <= to) void this.toggleRow(row.id);
	};

	/** Enter / double-click on a parent row toggles it (in view-only sheets; editable sheets edit). */
	onCellActivated = ([col, visibleRow]: Item) => {
		if (this.editable || col !== this.primaryIndex) return;
		const row = this.store.getRowAtVisible(visibleRow);
		if (row?.has_children) void this.toggleRow(row.id);
	};

	onSelectionChange = (selection: GridSelection) => {
		this.lastSelection = selection;
		this.selectedItem = selection.current?.cell ?? null;
		this.selectedRowIds = selection.rows
			.toArray()
			.slice(0, MAX_SELECTED_ROWS)
			.flatMap((visibleRow) => {
				const row = this.store.getRowAtVisible(visibleRow);
				return row ? [row.id] : [];
			});
		this.selectedColumnKeys = selection.columns.toArray().flatMap((col) => {
			const column = this.columns[col];
			return column ? [column.key] : [];
		});
		this.refreshSelected();
	};

	/** Renaming a group from its native hover action in the header (see SheetGridView). */
	onGroupHeaderRenamed = (groupName: string, newName: string) => {
		if (groupName && newName.trim() && newName.trim() !== groupName) this.groupRenameHandler?.(groupName, newName);
	};

	/** Set by SheetViewer so native group-header renames can trigger a write + refresh. */
	bindGroupRename(handler: ((groupName: string, newName: string) => void) | null) {
		this.groupRenameHandler = handler;
	}

	// -- Editing callbacks ----------------------------------------------------------

	/** Checkbox toggles arrive here; overlay edits are committed in `onFinishedEditing`. */
	onCellEdited = (item: Item, value: EditableGridCell) => {
		if (value.kind !== GridCellKind.Boolean) return;
		const target = this.cellAt(item);
		if (!target || !this.editor) return;
		void this.editor.setCellValue(target.row.id, target.column.key, typeof value.data === 'boolean' ? value.data : null);
	};

	/**
	 * IntelliSheet's overlay editors report their text through `trackEdit`; Glide calls
	 * this when the overlay closes (Enter, Tab, click outside), with `undefined`
	 * on Escape. Committing here instead of in onCellEdited also covers the kinds
	 * Glide treats as read-only (Bubble, Drilldown, RowID, Protected), whose edits
	 * it never forwards to onCellEdited.
	 */
	onFinishedEditing = (newValue: GridCell | undefined) => {
		const pending = this.pendingEdit;
		this.pendingEdit = null;
		if (!pending || newValue === undefined || !this.editor) return;
		void this.editor.setCellInputs([{ rowId: pending.rowId, columnKey: pending.columnKey, raw: pending.text }]);
	};

	/** Called when an overlay editor opens. */
	beginEdit() {
		this.pendingEdit = null;
	}

	/** Called by overlay editors with the text to commit if editing finishes. */
	trackEdit(meta: CellEditMeta, text: string) {
		this.pendingEdit = { rowId: meta.rowId, columnKey: meta.columnKey, text };
	}

	/** Pasted text is parsed per target column; returning false skips Glide's own paste. */
	onPaste = (target: Item, values: readonly (readonly string[])[]): boolean => {
		if (!this.editor) return false;
		const inputs: CellInput[] = [];
		values.forEach((line, dy) =>
			line.forEach((raw, dx) => {
				const cell = this.cellAt([target[0] + dx, target[1] + dy]);
				if (cell) inputs.push({ rowId: cell.row.id, columnKey: cell.column.key, raw });
			})
		);
		void this.editor.setCellInputs(inputs);
		return false;
	};

	/** Delete / Backspace clears the selected cells (whole-row deletion is an explicit action). */
	onDelete = (selection: GridSelection): boolean => {
		if (!this.editor) return false;
		const cells: FormulaCellKey[] = [];
		const add = (x: number, y: number) => {
			const cell = this.cellAt([x, y]);
			if (cell) cells.push({ rowId: cell.row.id, columnKey: cell.column.key });
		};

		const ranges = selection.current ? [selection.current.range, ...selection.current.rangeStack] : [];
		for (const range of ranges) {
			for (let y = range.y; y < range.y + range.height; y++) {
				for (let x = range.x; x < range.x + range.width; x++) add(x, y);
			}
		}
		for (const y of selection.rows.toArray().slice(0, MAX_SELECTED_ROWS)) {
			for (let x = 0; x < this.columns.length; x++) add(x, y);
		}

		void this.editor.clearCells(cells);
		return false;
	};

	onRowAppended = async (): Promise<undefined> => {
		await this.appendRow();
		return undefined;
	};

	// -- Commands ---------------------------------------------------------------------

	async toggleRow(rowId: string) {
		await this.store.toggleCollapsed(rowId);
	}

	expandAll() {
		this.store.expandAll();
	}

	async appendRow() {
		if (!this.editor) return;
		await this.editor.appendRows(1);
		setTimeout(() => this.scrollTo(this.store.visibleRowCount - 1, this.primaryIndex), 50);
	}

	async deleteSelectedRows() {
		if (!this.editor || this.selectedRowIds.length === 0) return;
		await this.editor.deleteRows(this.selectedRowIds);
		this.clearSelection();
	}

	/** Commits text typed in the formula bar to the selected cell. */
	commitSelectedInput(raw: string) {
		const selected = this.selected;
		if (!selected || !this.editor) return;
		void this.editor.setCellInputs([{ rowId: selected.rowId, columnKey: selected.columnKey, raw }]);
	}

	clearSelection() {
		this.setGridSelection?.(EMPTY_SELECTION);
		this.onSelectionChange(EMPTY_SELECTION);
	}

	scrollTo(visibleRow: number, col: number) {
		if (visibleRow < 0) return;
		this.ref?.scrollTo(col, visibleRow, 'both', 0, 0, { vAlign: 'center', hAlign: 'center' });
	}

	/** Scrolls to a sheet row (1-based position) and selects its cell, expanding collapsed parents if it's hidden. */
	revealRow(position: number, columnKey?: string) {
		let visibleRow = this.store.offsetToVisible(position - 1);
		if (visibleRow < 0) {
			this.store.expandAll();
			visibleRow = this.store.offsetToVisible(position - 1);
		}
		if (visibleRow < 0) return;
		const col = (columnKey ? this.columnIndex.get(columnKey) : undefined) ?? this.primaryIndex;
		const selection: GridSelection = {
			current: { cell: [col, visibleRow], range: { x: col, y: visibleRow, width: 1, height: 1 }, rangeStack: [] },
			columns: CompactSelection.empty(),
			rows: CompactSelection.empty()
		};
		this.setGridSelection?.(selection);
		this.onSelectionChange(selection);
		this.scrollTo(visibleRow, col);
	}

	/** Full visible redraw (e.g. after density or data refresh). */
	redraw() {
		this.damageViewport();
	}

	private cellAt([col, visibleRow]: Item): { row: RowData; column: Column } | undefined {
		const column = this.columns[col];
		const row = this.store.getRowAtVisible(visibleRow);
		return column && row ? { row, column } : undefined;
	}

	// -- Invalidation -------------------------------------------------------------------

	private handleStoreEvent(event: RowStoreEvent) {
		switch (event.kind) {
			case 'rows':
				this.runtime.enqueueRows(event.rows);
				this.damageOffsets(event.startOffset, event.endOffset);
				break;
			case 'structure':
				this.damageViewport();
				break;
			case 'evicted':
				this.runtime.forgetRows(event.rowIds);
				break;
		}
		this.refreshSelected();
	}

	private handleFormulaResults(cells: FormulaCellKey[]) {
		const first = this.viewport.y - 2;
		const last = this.viewport.y + this.viewport.height + 2;
		const damage: { cell: Item }[] = [];
		let selectionChanged = false;

		for (const { rowId, columnKey } of cells) {
			const col = this.columnIndex.get(columnKey);
			const offset = this.store.getRowOffset(rowId);
			if (col === undefined || offset === undefined) continue;
			const visibleRow = this.store.offsetToVisible(offset);
			if (visibleRow < first || visibleRow > last) continue;
			damage.push({ cell: [col, visibleRow] });
			if (this.selectedItem && this.selectedItem[0] === col && this.selectedItem[1] === visibleRow) {
				selectionChanged = true;
			}
		}

		if (damage.length > 0) this.ref?.updateCells(damage);
		if (selectionChanged) this.refreshSelected();
	}

	private damageOffsets(startOffset: number, endOffset: number) {
		const damage: { cell: Item }[] = [];
		const last = this.viewport.y + this.viewport.height;
		for (let visibleRow = this.viewport.y; visibleRow <= last; visibleRow++) {
			const offset = this.store.visibleToOffset(visibleRow);
			if (offset < startOffset || offset > endOffset) continue;
			for (let col = 0; col < this.columns.length; col++) damage.push({ cell: [col, visibleRow] });
		}
		if (damage.length > 0) this.ref?.updateCells(damage);
	}

	private damageViewport() {
		const damage: { cell: Item }[] = [];
		const last = this.viewport.y + this.viewport.height;
		for (let visibleRow = this.viewport.y; visibleRow <= last; visibleRow++) {
			for (let col = 0; col < this.columns.length; col++) damage.push({ cell: [col, visibleRow] });
		}
		if (damage.length > 0) this.ref?.updateCells(damage);
	}

	private refreshSelected() {
		const item = this.selectedItem;
		const target = item ? this.cellAt(item) : undefined;
		if (!item || !target) {
			if (this.selected !== null) this.selected = null;
			return;
		}

		const { row, column } = target;
		const value = row.data[column.key];
		const result = isFormulaCell(value) ? this.runtime.resultFor(row.id, column.key, value) : undefined;
		const primitive = cellPrimitive(value);
		const secret = column.data_type === 'protected';

		this.selected = {
			rowId: row.id,
			columnKey: column.key,
			rowNumber: this.store.getRowNumber(row.id) ?? item[1] + 1,
			columnName: column.name,
			columnType: column.data_type,
			display: cellDisplayText(column, value, result),
			raw: primitive === null ? '' : secret ? PROTECTED_MASK : String(primitive),
			// Protected values are only exposed to the (masked) editor of writable sheets.
			input: secret && !this.editable ? '' : cellInputText(value),
			formula: isFormulaCell(value) && !secret ? value.formula : undefined,
			result: secret ? undefined : result,
			secret,
			locked: !!column.settings.column_formula
		};
	}
}
