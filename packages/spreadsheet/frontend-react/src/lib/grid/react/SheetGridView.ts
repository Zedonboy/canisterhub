import {
	CompactSelection,
	DataEditor,
	type DataEditorProps,
	type DataEditorRef,
	type GridColumn,
	type GridSelection,
	type Highlight
} from '@glideapps/glide-data-grid';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { customRenderers } from '../column-types';
import { darkGridTheme, gridTheme, HEADER_HEIGHT } from '../grid-theme';
import type { SheetGridController } from '../sheet-grid-controller';
import { createEditorProvider } from './CellTextEditor';

export interface SheetGridViewProps {
	controller: SheetGridController;
	columns: GridColumn[];
	freezeColumns: number;
	rowCount: number;
	rowHeight: number;
	highlightRegions: Highlight[];
	editable: boolean;
	/** Draws the grid with the dark palette. */
	dark: boolean;
}

const EMPTY_SELECTION: GridSelection = {
	columns: CompactSelection.empty(),
	rows: CompactSelection.empty()
};

/** View-only sheets: every mutating interaction is disabled; selection and copy stay on. */
const READ_ONLY_KEYBINDINGS = {
	copy: true,
	cut: false,
	paste: false,
	delete: false,
	clear: false,
	downFill: false,
	rightFill: false,
	search: false
};

const EDITABLE_KEYBINDINGS = { ...READ_ONLY_KEYBINDINGS, paste: true, delete: true, clear: true };

const rejectDelete = () => false;

/**
 * React island hosting Glide Data Grid. Glide is React-only, so Svelte mounts
 * this component (see mount.ts) and passes a controller that owns the data.
 */
export function SheetGridView(props: SheetGridViewProps) {
	const { controller, editable } = props;
	const ref = useRef<DataEditorRef>(null);
	const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
	const provideEditor = useMemo(() => createEditorProvider(controller), [controller]);

	useEffect(() => {
		controller.attach(ref.current);
		controller.bindSelection(setSelection);
		return () => {
			controller.attach(null);
			controller.bindSelection(null);
		};
	}, [controller]);

	// Redraw visible cells when row height, editability or the theme changes
	// (custom renderers such as enum pills pick their colours per theme).
	useEffect(() => {
		controller.redraw();
	}, [controller, props.rowHeight, editable, props.dark]);

	const onGridSelectionChange = useCallback(
		(next: GridSelection) => {
			setSelection(next);
			controller.onSelectionChange(next);
		},
		[controller]
	);

	const editingProps: Partial<DataEditorProps> = editable
		? {
				keybindings: EDITABLE_KEYBINDINGS,
				provideEditor,
				onCellEdited: controller.onCellEdited,
				onFinishedEditing: controller.onFinishedEditing,
				onHeaderMenuClick: controller.onHeaderMenuClick,
				onHeaderContextMenu: controller.onHeaderContextMenu,
				onPaste: controller.onPaste,
				onDelete: controller.onDelete,
				onKeyDown: controller.onKeyDown,
				// Hover "Rename" action on a grouped header (see bindGroupRename in SheetViewer).
				onGroupHeaderRenamed: controller.onGroupHeaderRenamed,
				onRowAppended: controller.onRowAppended,
				trailingRowOptions: { hint: 'Add row', sticky: true, tint: true }
			}
		: {
				keybindings: READ_ONLY_KEYBINDINGS,
				onPaste: false,
				onDelete: rejectDelete
			};

	return createElement(DataEditor, {
		ref,
		width: '100%',
		height: '100%',
		columns: props.columns,
		rows: props.rowCount,
		rowHeight: props.rowHeight,
		headerHeight: HEADER_HEIGHT,
		freezeColumns: props.freezeColumns,
		theme: props.dark ? darkGridTheme : gridTheme,
		customRenderers,
		getCellContent: controller.getCellContent,
		getCellsForSelection: true,
		getRowThemeOverride: controller.getRowThemeOverride,
		onVisibleRegionChanged: controller.onVisibleRegionChanged,
		onColumnResize: controller.onColumnResize,
		onCellClicked: controller.onCellClicked,
		onCellActivated: controller.onCellActivated,
		// IntelliSheet's own context menu (see GridContextMenu.svelte) replaces the browser's.
		onCellContextMenu: controller.onCellContextMenu,
		gridSelection: selection,
		onGridSelectionChange,
		highlightRegions: props.highlightRegions,
		rowMarkers: 'clickable-number',
		rowSelect: 'multi',
		columnSelect: 'multi',
		rangeSelect: 'multi-rect',
		smoothScrollX: true,
		smoothScrollY: true,
		// No fill handle or drag-reordering in either mode yet.
		fillHandle: false,
		minColumnWidth: 60,
		maxColumnWidth: 800,
		...editingProps
	});
}
